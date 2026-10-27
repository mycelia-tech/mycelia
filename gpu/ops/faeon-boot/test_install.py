import importlib.util
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('boot_install', Path(__file__).with_name('install.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='faeon-install-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.stage = self.root / 'stage'
        self.stage.mkdir()
        self.live = self.root / 'live'
        self.live.mkdir()
        self.bundle = Path(__file__).parent
        self.contents = {name: (self.bundle / name).read_bytes() for name in installer.EXPECTED}
        self.targets = {
            'faeon-runtime-admin': (self.live / 'faeon-runtime-admin', 0o755),
            'faeon-datadrive': (self.live / 'faeon-datadrive', 0o644),
            'sudoers-faeon-runtime': (self.live / 'sudoers-faeon-runtime', 0o440),
        }
        self.helper = self.targets['faeon-runtime-admin'][0]
        self.service = self.targets['faeon-datadrive'][0]
        self.sudoers = self.targets['sudoers-faeon-runtime'][0]
        self.dockerd = self.live / 'dockerd'
        self.original = b'type = process\ncommand = /usr/lib/dinit/dockerd\n'
        self.updated = self.original + b'depends-on = faeon-datadrive\n'
        self.dockerd.write_bytes(self.original)
        self.dockerd.chmod(0o755)
        (self.stage / 'dockerd').write_bytes(self.updated)
        self.sudo_stage = self.root / 'sudoers.proposed'
        self.sudo_stage.write_bytes(self.contents['sudoers-faeon-runtime'])
        self.validation_count = 0
        self.failure_at = None
        self.on_second_check = None
        # Test actual temp file identities/content without requiring root on the
        # developer host. Only ownership and privileged-parent checks are mocked.
        self.owner = 0
        real_fstat = os.fstat

        def root_fstat(fd):
            fields = list(real_fstat(fd))
            fields[4] = self.owner
            return os.stat_result(fields)

        for context in (
            patch.object(installer, 'trusted'),
            patch.object(installer.os, 'fstat', side_effect=root_fstat),
            patch.object(installer, 'checked', side_effect=self.validate),
        ):
            context.start()
            self.addCleanup(context.stop)

    def assert_not_activated(self):
        self.assertFalse(self.service.exists())
        self.assertFalse(self.sudoers.exists())
        self.assertEqual(self.dockerd.read_bytes(), self.original)

    def validate(self, args, timeout=30):
        if args[0] != '/usr/bin/dinit-check':
            return
        self.validation_count += 1
        self.assert_not_activated()
        candidate = (self.stage / 'faeon-datadrive').read_bytes()
        if self.validation_count == 1:
            executable = self.stage / 'faeon-runtime-admin'
            self.assertFalse(self.helper.exists())
            command = b'command = ' + os.fsencode(executable) + b' mount'
            self.assertIn(command, candidate.splitlines())
        else:
            executable = self.helper
            self.assertEqual(candidate, self.contents['faeon-datadrive'])
        self.assertEqual(executable.read_bytes(), self.contents['faeon-runtime-admin'])
        self.assertEqual(stat.S_IMODE(executable.stat().st_mode), 0o755)
        if self.validation_count == 2 and self.on_second_check:
            self.on_second_check()
        if self.validation_count == self.failure_at:
            raise RuntimeError('simulated dinit validation failure')

    def activate(self):
        installer.activate_configuration(
            self.stage, self.sudo_stage, self.contents, self.targets,
            self.dockerd, self.updated,
        )

    def test_success_validates_executable_before_publishing_privileges(self):
        self.activate()
        self.assertEqual(self.validation_count, 2)
        self.assertEqual(self.helper.read_bytes(), self.contents['faeon-runtime-admin'])
        self.assertEqual(self.service.read_bytes(), self.contents['faeon-datadrive'])
        self.assertEqual(self.sudoers.read_bytes(), self.contents['sudoers-faeon-runtime'])
        self.assertEqual(self.dockerd.read_bytes(), self.updated)
        self.assertEqual(stat.S_IMODE(self.dockerd.stat().st_mode), 0o755)

    def test_first_validation_failure_changes_no_live_files(self):
        self.failure_at = 1
        with self.assertRaisesRegex(RuntimeError, 'simulated dinit'):
            self.activate()
        self.assertFalse(self.helper.exists())
        self.assert_not_activated()

    def test_second_validation_failure_removes_only_created_helper(self):
        self.failure_at = 2
        with self.assertRaisesRegex(RuntimeError, 'simulated dinit'):
            self.activate()
        self.assertFalse(self.helper.exists())
        self.assert_not_activated()

    def test_second_validation_failure_preserves_replacement_inode(self):
        def replace():
            replacement = self.live / 'replacement'
            replacement.write_bytes(self.contents['faeon-runtime-admin'])
            replacement.chmod(0o755)
            os.replace(replacement, self.helper)

        self.failure_at = 2
        self.on_second_check = replace
        with self.assertRaisesRegex(RuntimeError, 'changed; preserve'):
            self.activate()
        self.assertTrue(self.helper.exists())
        self.assert_not_activated()

    def test_second_validation_failure_preserves_modified_content(self):
        self.failure_at = 2
        modified = b'!' + self.contents['faeon-runtime-admin'][1:]
        self.on_second_check = lambda: self.helper.write_bytes(modified)
        with self.assertRaisesRegex(RuntimeError, 'changed; preserve'):
            self.activate()
        self.assertEqual(self.helper.read_bytes(), modified)
        self.assert_not_activated()

    def test_second_validation_failure_preserves_changed_mode(self):
        self.failure_at = 2
        self.on_second_check = lambda: self.helper.chmod(0o700)
        with self.assertRaisesRegex(RuntimeError, 'changed; preserve'):
            self.activate()
        self.assertTrue(self.helper.exists())
        self.assert_not_activated()

    def test_second_validation_failure_preserves_changed_owner(self):
        self.failure_at = 2
        self.on_second_check = lambda: setattr(self, 'owner', 1002)
        with self.assertRaisesRegex(RuntimeError, 'changed; preserve'):
            self.activate()
        self.assertTrue(self.helper.exists())
        self.assert_not_activated()

    def test_staged_command_requires_one_exact_reviewed_line(self):
        service = self.contents['faeon-datadrive']
        helper = self.stage / 'faeon-runtime-admin'
        for invalid in (service.replace(b' mount', b' status'), service + service):
            with self.assertRaisesRegex(RuntimeError, 'exactly one'):
                installer.staged_service(invalid, helper)


if __name__ == '__main__':
    unittest.main()
