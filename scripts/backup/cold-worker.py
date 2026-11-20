"""Verify an immutable cold Mongo backup, then restore only a separate copy."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import time

ROOT = Path('/mnt/datadrive/db-backups')
UUID = '816b292e-4e7e-4965-85b8-24abbb3e000d'


def guard(run):
    assert ROOT.resolve() == ROOT and run.resolve().parent == ROOT
    assert run.name.startswith('mycelia-cold-') and os.path.ismount('/mnt/datadrive')
    disk = subprocess.check_output(['findmnt', '-n', '-o', 'UUID', '-T', str(ROOT)], text=True).strip()
    assert disk == UUID, 'Wrong backup disk'
    for path in (ROOT, run):
        s = path.stat()
        assert s.st_uid == os.getuid() and stat.S_IMODE(s.st_mode) & 0o077 == 0


def save(run, value):
    value['updatedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    tmp = run / 'restore-status.json.tmp'
    with open(tmp, 'w') as f:
        os.fchmod(f.fileno(), 0o600)
        json.dump(value, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, run / 'restore-status.json')


def verify(snapshot, manifest):
    expected = set()
    for entry in manifest['files']:
        name = entry['path']
        assert not name.startswith('/') and '..' not in Path(name).parts
        path = snapshot / name
        assert path.resolve().is_relative_to(snapshot.resolve())
        assert path.is_file() and not path.is_symlink()
        assert path.stat().st_size == entry['size']
        digest = hashlib.sha256()
        with open(path, 'rb') as f:
            for block in iter(lambda: f.read(8 * 1024 * 1024), b''):
                digest.update(block)
        assert digest.hexdigest() == entry['sha256'], 'Hash mismatch: ' + name
        expected.add(name)
    actual = {str(p.relative_to(snapshot)) for p in snapshot.rglob('*') if p.is_file()}
    assert actual == expected | {'manifest.json'}, 'Unexpected snapshot files'


def command(args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


VALIDATE = """
const result=[];
const databases=db.adminCommand({listDatabases:1});
if(databases.ok!==1)quit(1);
for(const item of databases.databases){
 if(item.name==='local')continue;
 const target=db.getSiblingDB(item.name);
 for(const c of target.getCollectionInfos({type:'collection'})){
  const v=target.runCommand({validate:c.name,full:true});
  if(v.ok!==1||v.valid!==true){print('INVALID_COLLECTION');quit(2);}
  result.push({database:item.name,collection:c.name,documents:target.getCollection(c.name).countDocuments({})});
 }
}
if(!result.some(c=>c.database==='mycelia'&&c.collection==='audio_chunks'&&c.documents>0))quit(3);
print(JSON.stringify({collections:result}));
"""


def main(run):
    os.umask(0o077)
    guard(run)
    lock = open(run / 'worker.lock', 'a')
    os.fchmod(lock.fileno(), 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return
    state_path = run / 'restore-status.json'
    if state_path.exists() and json.loads(state_path.read_text()).get('state') == 'complete':
        return
    snapshot = run / 'snapshot'
    manifest = json.loads((snapshot / 'manifest.json').read_text())
    state = {'state': 'verifying', 'runId': run.name, 'transferVerified': False, 'restoreVerified': False}
    container = None
    created = False
    try:
        save(run, state)
        verify(snapshot, manifest)
        state.update(state='transfer_verified', transferVerified=True,
                     bytes=sum(e['size'] for e in manifest['files']), files=len(manifest['files']))
        save(run, state)
        image = manifest['mongoImage']
        assert image.startswith('mongo@sha256:') and len(image.split(':')[-1]) == 64
        # Digest-pinned multi-architecture official image, same release as source.
        command(['docker', 'pull', image])
        state['state'] = 'copying_restore_target'
        save(run, state)
        target = run / ('restore-' + str(int(time.time())))
        target.mkdir(mode=0o700)
        os.chmod(target, 0o700)
        assert shutil.disk_usage(run).free > state['bytes'] * 2
        # Never hard-link mutable restore data to the preserved backup.
        command(['cp', '-R', '--reflink=auto', str(snapshot / 'db'), str(target / 'db')])
        container = 'mycelia-cold-drill-' + run.name.removeprefix('mycelia-cold-')[-36:]
        state.update(state='restoring', restorePath=str(target), container=container)
        save(run, state)
        # A retry must not replace a prior restore container or its data.
        existing = subprocess.run(['docker', 'inspect', container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        assert existing.returncode != 0, 'Prior restore container retained; inspect before retry'
        command(['docker', 'run', '-d', '--name', container,
                 '--label', 'tech.mycelia.cold-drill=' + run.name,
                 '--network', 'none', '--read-only', '--tmpfs', '/tmp',
                 '--tmpfs', '/data/configdb', '--user', str(os.getuid()) + ':' + str(os.getgid()),
                 '--memory', '4g', '--cpus', '2', '--pids-limit', '256',
                 '--mount', 'type=bind,source=' + str(target / 'db') + ',target=/data/db',
                 image, 'mongod', '--bind_ip', '127.0.0.1', '--noauth', '--wiredTigerCacheSizeGB', '1'])
        created = True
        ready = False
        for _ in range(180):
            test = subprocess.run(['docker', 'exec', container, 'mongosh', '--quiet', '--eval',
                                   'if(db.adminCommand({ping:1}).ok!==1)quit(1)'],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
            if test.returncode == 0:
                ready = True
                break
            if command(['docker', 'inspect', '--format', '{{.State.Running}}', container]) != 'true':
                break
            time.sleep(5)
        assert ready, 'Isolated Mongo restore failed to become ready; preserve logs and data'
        state['state'] = 'validating_collections'
        save(run, state)
        validated = json.loads(command(['docker', 'exec', container, 'mongosh', '--quiet', '--eval', VALIDATE]))
        command(['docker', 'stop', '--time', '60', container])
        state.update(state='complete', restoreVerified=True, validation=validated,
                     completedAt=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))
        save(run, state)
    except Exception as error:
        state.update(state='failed', failure=str(error))
        save(run, state)
        if created:
            subprocess.run(['docker', 'stop', '--time', '60', container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        raise


if __name__ == '__main__':
    main(Path(sys.argv[1]))
