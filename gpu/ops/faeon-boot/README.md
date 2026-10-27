# Faeon datadrive boot guard and limited sudo

Prepared for the existing Artix/dinit 0.22 host, SSH user `Skywinder` (UID 1002).
The host currently reports hostname `bastion`; the SSH alias is `faeon`.
The expected disk is ext4 UUID `816b292e-4e7e-4965-85b8-24abbb3e000d`,
currently `/dev/nvme0n1p1`, mounted at `/mnt/datadrive` with `defaults`.
Device names can change; the guard binds to the UUID and filesystem type.

The existing `/etc/dinit.d/early-fs-local.target` overrides the vendor target
with an empty internal target, omitting the normal fstab dependency chain.
This bundle preserves that override and adds one hard dependency to the existing
`dockerd` service: `faeon-datadrive`. On subsequent boots Docker waits for the
correct disk. If the guard fails, Docker stays stopped; it cannot silently use
empty model/state directories on the root filesystem. The service preserves
all original Docker flags/dependencies. No Docker daemon reload/restart,
container start/stop, model download, formatting or fsck is performed.

## One-time installation

Review the installer, helper, service, sudoers rule and checksums, copy the bundle to one private directory
on faeon, then run in a user-visible terminal:

```sh
ssh -t faeon
sudo /usr/bin/python3 -I /absolute/path/to/reviewed-bundle/install.py
```

Enter the server sudo password only in that terminal. The installer accepts no
arguments. It checks exact source checksums, the previously observed Docker
service checksum and existing fstab identity. It validates sudoers and the dinit
dependency graph before activation. The first full dinit check uses an executable
helper copy in the root-private staging directory. After that passes, only the
live helper is installed, and a second full check uses the exact production
service command. The live service, Docker dependency and NOPASSWD grant are
published only after both checks succeed. If the second check fails, the helper
is removed only if its inode, device, root ownership, mode and SHA256 still
match this attempt; a changed or replaced helper is preserved for inspection.
This also avoids requiring the not-yet-installed live executable during the
first check. Root-owned backups and the installation
receipt are saved under `/var/lib/faeon-runtime-admin/<timestamp>-<suffix>/`.

The only NOPASSWD commands granted to `Skywinder` are:

```sh
sudo -n /usr/local/sbin/faeon-runtime-admin status
sudo -n /usr/local/sbin/faeon-runtime-admin mount
```

There is no permission for arbitrary commands, shell, Docker, path/options,
service changes, deletion, unmount, repair or credential access. The wrapper
uses isolated Python, fixed absolute binaries and a clean environment.

For this one-time recovery, the installer preserves the known empty root-owned
placeholder directory tree by moving it into the root-private backup directory,
then creates an empty mountpoint. Unexpected files, symlinks, directories or
nested mounts stop installation rather than being hidden or removed. This
preservation step is not available through the NOPASSWD wrapper.

Installation mounts the disk now using the fixed identity and normal ext4 mount
semantics (including normal kernel journal replay if needed). It does not run
filesystem repair. A failed mount remains a failure and must be investigated.
After mounting, start/recover only the separately authorized existing containers
through the user's existing Docker access. Do not start intentionally stopped
27B models, archived stacks or duplicate WLK. Container readiness and real
inference are separate checks.

## Validation and rollback

Four offline guard tests cover wrong filesystem/UUID/root/read-only identity,
idempotence, refusal of wrong existing mounts and extra-argument rejection.
Eight installer regression tests cover staged/production executable validation,
publication ordering, failure cleanup and preservation of replaced or modified
helpers. Run them from this bundle directory with
`python3 -B -m unittest discover -s . -p 'test_*.py'`; they use temporary files and
mock privileged checks, without executing sudo, dinit or mount commands.
Installed `visudo` and `dinit-check` validate configuration. Inspect guard status,
the exact mount UUID, expected model/cache files and individual container jobs.
**A reboot has not been tested.** Installing the dependency does not reload the
running dinit service; it applies on the next normal service load/boot.

For rollback, use a normal authenticated root session and the exact printed
backup directory. Restore `dockerd.original` to `/etc/dinit.d/dockerd` with its
original mode 0755; remove only `/etc/dinit.d/faeon-datadrive`,
`/etc/sudoers.d/faeon-runtime` and `/usr/local/sbin/faeon-runtime-admin` after
checking they still match this receipt. Validate with `visudo -c` and
`dinit-check --system dockerd`. This removes the next-boot guard and the limited
sudo grant without interrupting currently running Docker or unmounting data.
Do not restore the empty placeholder tree over the mounted disk. Its backup
can remain for inspection; restoring it would require a separate idle/unmounted
maintenance operation. The original fstab is backed up but not modified.

Reference: [Dinit service dependencies and scripted services](https://davmac.org/projects/dinit/man-pages-html/dinit-service.5.html).
