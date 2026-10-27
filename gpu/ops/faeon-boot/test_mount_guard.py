import importlib.machinery
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

path = Path(__file__).with_name('faeon-runtime-admin')
loader = importlib.machinery.SourceFileLoader('mount_guard', str(path))
spec = importlib.util.spec_from_loader(loader.name, loader)
guard = importlib.util.module_from_spec(spec)
loader.exec_module(guard)


class MountGuardTests(unittest.TestCase):
    def valid(self):
        return {'target': str(guard.TARGET), 'uuid': guard.UUID,
                'fstype': 'ext4', 'fsroot': '/', 'options': 'rw,relatime'}

    def test_identity_rejects_wrong_device_root_type_readonly(self):
        self.assertTrue(guard.correct_mount(self.valid()))
        for key, value in [('target', '/'), ('uuid', 'wrong'),
                           ('fstype', 'xfs'), ('fsroot', '/some/subdir'),
                           ('options', 'ro,relatime')]:
            self.assertFalse(guard.correct_mount({**self.valid(), key: value}))
        self.assertFalse(guard.correct_mount(None))

    def test_existing_wrong_mount_does_not_execute_mount(self):
        with patch.object(guard, 'root_path'), patch.object(guard, 'mount_record', return_value={'target': '/wrong'}), patch.object(guard, 'run') as run:
            with self.assertRaises(RuntimeError):
                guard.mount_disk()
            run.assert_not_called()

    def test_existing_correct_mount_is_idempotent(self):
        with patch.object(guard, 'root_path'), patch.object(guard, 'mount_record', return_value=self.valid()), patch.object(guard, 'run') as run:
            self.assertFalse(guard.mount_disk()['changed'])
            run.assert_not_called()

    def test_extra_arguments_rejected_before_privileged_work(self):
        with patch.object(guard.sys, 'argv', ['helper', 'mount', '/etc']), patch.object(guard, 'run') as run:
            with self.assertRaises(RuntimeError):
                guard.main()
            run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
