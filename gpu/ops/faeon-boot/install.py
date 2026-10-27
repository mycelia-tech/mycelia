#!/usr/bin/python3 -I
"""One-time, explicitly reviewed root install; never restarts Docker."""
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import time
import uuid

EXPECTED = {'faeon-runtime-admin': 'b6c13374849c1b8a2a35dac37b97ee6234ec39e7390af33f3be3eee8f6d3d8b2', 'faeon-datadrive': '264e6bc815c0f66650237d811395860aaee6ee384987a3720546d546d9cf2c13', 'sudoers-faeon-runtime': '0f86c3304785799d456566007d498d095451ad4325709760d97b50728078df90'}
DOCKERD_SHA = 'f4a530dadbdda88104ae4e0a903e661f42690145b6f9f518ed9cca4713bb0e98'
UUID = '816b292e-4e7e-4965-85b8-24abbb3e000d'
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C', 'HOME': '/root'}
SHADOW_DIRS = {
    'sky-services', 'sky-services/projects', 'sky-services/projects/omiloc',
    'sky-services/projects/omiloc/docker',
    'sky-services/projects/omiloc/docker/nginx.conf',
    'sky-services/projects/qwen', 'sky-services/projects/qwen/models',
    'sky-services/projects/qwen/models/small-uncensored',
}


def trusted(path, directory=False):
    for node in [*reversed(path.parents), path]:
        info = node.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('Unsafe root destination: ' + str(node))
    if directory and not path.is_dir():
        raise RuntimeError('Not a directory: ' + str(path))


def write_new(path, content, mode):
    trusted(path.parent, True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as output:
        output.write(content)
        output.flush()
        os.fchmod(output.fileno(), mode)
        os.fsync(output.fileno())
        return os.fstat(output.fileno())


def checked(args, timeout=30):
    result = subprocess.run(args, cwd='/', env=ENV, capture_output=True,
                            text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError('Validation failed: ' + args[0] + '\n' + result.stderr[-2000:])


def staged_service(service, helper_path):
    command = b'command = /usr/local/sbin/faeon-runtime-admin mount'
    if service.splitlines().count(command) != 1:
        raise RuntimeError('Expected exactly one reviewed mount command')
    if not helper_path.is_absolute() or any(c.isspace() for c in str(helper_path)):
        raise RuntimeError('Unsafe staging executable path')
    replacement = b'command = ' + os.fsencode(helper_path) + b' mount'
    return b''.join(
        replacement + line[len(command):] if line.rstrip(b'\r\n') == command else line
        for line in service.splitlines(keepends=True)
    )


def remove_created_helper(path, created, content):
    """Remove only this attempt's unchanged root-owned helper after failure."""
    trusted(path.parent, True)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError as error:
        raise RuntimeError('Cannot verify created helper; preserve it for inspection') from error
    with os.fdopen(fd, 'rb') as source:
        current = os.fstat(source.fileno())
        if (not stat.S_ISREG(current.st_mode)
                or (current.st_dev, current.st_ino) != (created.st_dev, created.st_ino)
                or current.st_uid != 0 or stat.S_IMODE(current.st_mode) != 0o755
                or current.st_size != len(content)
                or hashlib.sha256(source.read()).digest() != hashlib.sha256(content).digest()):
            raise RuntimeError('Created helper changed; preserve it for inspection')
        named = path.lstat()
        if (named.st_dev, named.st_ino) != (current.st_dev, current.st_ino):
            raise RuntimeError('Created helper was replaced; preserve it for inspection')
        path.unlink()


def activate_configuration(stage, sudo_stage, contents, targets, dockerd, new_dockerd):
    """Validate a real executable twice before publishing services or sudo access."""
    helper_name = 'faeon-runtime-admin'
    helper_content = contents[helper_name]
    staged_helper = stage / helper_name
    service = stage / 'faeon-datadrive'
    write_new(staged_helper, helper_content, 0o755)
    write_new(service, staged_service(contents['faeon-datadrive'], staged_helper), 0o600)
    checker = ['/usr/bin/dinit-check', '-d', str(stage), '-d', '/etc/dinit.d',
               '-d', '/usr/lib/dinit.d', 'dockerd']
    checked(['/usr/bin/visudo', '-c', '-f', str(sudo_stage)])
    checked(checker)

    helper_path, helper_mode = targets[helper_name]
    created = write_new(helper_path, helper_content, helper_mode)
    try:
        production_service = stage / 'faeon-datadrive.production'
        write_new(production_service, contents['faeon-datadrive'], 0o600)
        os.replace(production_service, service)
        checked(checker)
    except BaseException:
        remove_created_helper(helper_path, created, helper_content)
        raise

    # No NOPASSWD grant or live dependency is installed before both full checks.
    for name, (path, mode) in targets.items():
        if name != helper_name:
            write_new(path, contents[name], mode)
    replacement = dockerd.with_name('dockerd.faeon-next')
    write_new(replacement, new_dockerd, stat.S_IMODE(dockerd.stat().st_mode))
    os.replace(replacement, dockerd)
    checked(['/usr/bin/visudo', '-c'])


def inspect_shadow(target):
    trusted(target, True)
    # Do not move any mount or nested mount, even if it appears empty.
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        mountpoint = line.split()[4]
        if mountpoint == str(target) or mountpoint.startswith(str(target) + '/'):
            raise RuntimeError('Mountpoint changed while preparing shadow inventory')
    seen = set()
    for parent, dirs, files in os.walk(target, followlinks=False):
        if files:
            raise RuntimeError('Unexpected files below unmounted datadrive; nothing moved')
        for name in dirs:
            path = Path(parent) / name
            trusted(path, True)
            relative = str(path.relative_to(target))
            if relative not in SHADOW_DIRS:
                raise RuntimeError('Unexpected shadow directory; nothing moved')
            seen.add(relative)
    return sorted(seen)


def main():
    if os.geteuid() != 0 or len(sys.argv) != 1:
        raise RuntimeError('Run once: sudo /usr/bin/python3 -I /absolute/path/install.py')
    os.umask(0o077)
    os.chdir('/')
    bundle = Path(__file__).resolve().parent
    contents = {}
    for name, digest in EXPECTED.items():
        path = bundle / name
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o022:
            raise RuntimeError('Unsafe bundle file: ' + name)
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != digest:
            raise RuntimeError('Bundle checksum mismatch: ' + name)
        contents[name] = raw
    if len(contents) != 3:
        raise RuntimeError('Bundle hashes were not finalized')
    dockerd = Path('/etc/dinit.d/dockerd')
    trusted(dockerd)
    original = dockerd.read_bytes()
    if hashlib.sha256(original).hexdigest() != DOCKERD_SHA:
        raise RuntimeError('dockerd differs from reviewed configuration; no changes made')
    fstab = Path('/etc/fstab')
    trusted(fstab)
    entries = [line.split() for line in fstab.read_text().splitlines()
               if line.strip() and not line.lstrip().startswith('#')]
    matches = [parts for parts in entries if len(parts) >= 3 and parts[1] == '/mnt/datadrive']
    if len(matches) != 1 or matches[0][:3] != ['UUID=' + UUID, '/mnt/datadrive', 'ext4']:
        raise RuntimeError('fstab identity differs from reviewed disk')
    targets = {
        'faeon-runtime-admin': (Path('/usr/local/sbin/faeon-runtime-admin'), 0o755),
        'faeon-datadrive': (Path('/etc/dinit.d/faeon-datadrive'), 0o644),
        'sudoers-faeon-runtime': (Path('/etc/sudoers.d/faeon-runtime'), 0o440),
    }
    for path, _ in targets.values():
        trusted(path.parent, True)
        if path.exists() or path.is_symlink():
            raise RuntimeError('Existing installation/unknown file: ' + str(path))
    # Execute only the in-memory bytes whose embedded checksum was verified;
    # __main__ is not used, so this loads pure inspection helpers only.
    helper = {'__name__': 'installer_preflight'}
    exec(compile(contents['faeon-runtime-admin'], 'verified_mount_guard', 'exec'), helper)
    target = Path('/mnt/datadrive')
    initial_record = helper['mount_record']()
    if initial_record is None:
        inspect_shadow(target)
    elif not helper['correct_mount'](initial_record):
        raise RuntimeError('Wrong filesystem mounted; no configuration changed')
    backup_parent = Path('/var/lib/faeon-runtime-admin')
    trusted(backup_parent.parent, True)
    if not backup_parent.exists():
        backup_parent.mkdir(mode=0o700)
    trusted(backup_parent, True)
    backup = backup_parent / (time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + uuid.uuid4().hex[:8])
    backup.mkdir(mode=0o700)
    write_new(backup / 'dockerd.original', original, 0o600)
    write_new(backup / 'fstab.original', fstab.read_bytes(), 0o600)
    new_dockerd = original.rstrip(b'\n') + b'\ndepends-on = faeon-datadrive\n'
    stage = backup / 'service-check'
    stage.mkdir(mode=0o700)
    write_new(stage / 'dockerd', new_dockerd, 0o600)
    sudo_stage = backup / 'sudoers.proposed'
    write_new(sudo_stage, contents['sudoers-faeon-runtime'], 0o600)
    activate_configuration(stage, sudo_stage, contents, targets, dockerd, new_dockerd)
    record = helper['mount_record']()
    shadow = None
    if record is None:
        inventory = inspect_shadow(target)
        if inventory:
            if target.stat().st_dev != backup.stat().st_dev:
                raise RuntimeError('Shadow backup would cross filesystems; nothing moved')
            shadow = backup / 'unmounted-empty-datadrive'
            os.rename(target, shadow)
            target.mkdir(mode=0o755)
    elif not helper['correct_mount'](record):
        raise RuntimeError('Wrong filesystem mounted; refusing to replace it')
    receipt = {'backup': str(backup), 'old_dockerd_sha256': DOCKERD_SHA,
               'new_dockerd_sha256': hashlib.sha256(new_dockerd).hexdigest(),
               'bundle_sha256': EXPECTED, 'shadow_backup': str(shadow) if shadow else None,
               'docker_restarted': False, 'containers_started': False,
               'reboot_tested': False}
    write_new(backup / 'receipt.json', (json.dumps(receipt, indent=2) + '\n').encode(), 0o600)
    print(json.dumps({'installed': True, 'backup': str(backup), 'docker_restarted': False}), flush=True)
    # This command can also be repeated later through the narrow NOPASSWD rule.
    checked(['/usr/local/sbin/faeon-runtime-admin', 'mount'], timeout=180)
    result = subprocess.run(['/usr/local/sbin/faeon-runtime-admin', 'status'],
                            cwd='/', env=ENV, text=True, timeout=15)
    if result.returncode:
        raise RuntimeError('Installation succeeded; final mount status failed')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('INSTALL STOPPED: ' + str(error), file=sys.stderr)
        sys.exit(1)
