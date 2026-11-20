"""Opt-in, synthetic-only cold restore test on the backup server."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import uuid

spec = importlib.util.spec_from_file_location('worker', Path(__file__).with_name('cold-worker.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
image = 'mongo@sha256:e0ce8c35124d4a9f9785532d1f268f39e9728ffa1cb38f46fa482436424c4bd3'


def main():
    os.umask(0o077)
    token = str(uuid.uuid4())
    run = worker.ROOT / ('mycelia-cold-probe-' + token)
    run.mkdir(mode=0o700)
    os.chmod(run, 0o700)
    worker.guard(run)
    snapshot = run / 'snapshot'
    db = snapshot / 'db'
    db.mkdir(parents=True, mode=0o700)
    name = 'mycelia-cold-probe-source-' + token
    print('synthetic_fixture=' + str(run), flush=True)
    created = False
    succeeded = False
    try:
        worker.command(['docker', 'run', '-d', '--name', name,
                        '--label', 'tech.mycelia.cold-probe=' + token,
                        '--network', 'none', '--read-only', '--tmpfs', '/tmp',
                        '--tmpfs', '/data/configdb', '--user', str(os.getuid()) + ':' + str(os.getgid()),
                        '--memory', '1g', '--cpus', '1', '--pids-limit', '256',
                        '--mount', 'type=bind,source=' + str(db) + ',target=/data/db',
                        image, 'mongod', '--bind_ip', '127.0.0.1', '--noauth', '--wiredTigerCacheSizeGB', '0.25'])
        created = True
        for _ in range(60):
            r = subprocess.run(['docker', 'exec', name, 'mongosh', '--quiet', '--eval',
                                "db.getSiblingDB('mycelia').audio_chunks.insertOne({_id:'synthetic',data:BinData(0,'YWJj')});db.getSiblingDB('mycelia').source_files.insertOne({_id:'synthetic',path:'/synthetic/test.m4a'});"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if r.returncode == 0:
                break
            time.sleep(2)
        else:
            raise RuntimeError('Fixture source did not start')
        worker.command(['docker', 'stop', '--time', '60', name])
        files = []
        for p in sorted(snapshot.rglob('*')):
            if p.is_file():
                h = hashlib.sha256()
                with open(p, 'rb') as f:
                    for block in iter(lambda: f.read(8 * 1024 * 1024), b''):
                        h.update(block)
                files.append({'path': str(p.relative_to(snapshot)), 'size': p.stat().st_size, 'sha256': h.hexdigest()})
        (snapshot / 'manifest.json').write_text(json.dumps({'mongoImage': image, 'files': files, 'syntheticOnly': True}))
        worker.main(run)
        status = json.loads((run / 'restore-status.json').read_text())
        assert status['state'] == 'complete' and status['restoreVerified']
        assert any(c['collection'] == 'audio_chunks' and c['documents'] == 1 for c in status['validation']['collections'])
        # Verify backup files remain unchanged after mutable restore recovery.
        worker.verify(snapshot, json.loads((snapshot / 'manifest.json').read_text()))
        print(json.dumps({'syntheticOnly': True, 'transferVerified': True, 'restoreVerified': True}), flush=True)
        target = status['container']
        label = worker.command(['docker', 'inspect', '--format', '{{index .Config.Labels "tech.mycelia.cold-drill"}}', target])
        assert label == run.name
        worker.command(['docker', 'rm', target])
        succeeded = True
    finally:
        if created:
            subprocess.run(['docker', 'stop', '--time', '30', name], stdout=subprocess.DEVNULL)
            worker.command(['docker', 'rm', name])
        if succeeded:
            assert run.resolve().parent == worker.ROOT and run.name == 'mycelia-cold-probe-' + token
            shutil.rmtree(run)
            print('Synthetic fixture removed; real backups untouched', flush=True)


if __name__ == '__main__':
    main()
