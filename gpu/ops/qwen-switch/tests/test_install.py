"""An interrupted or stale install must not split the script/helper pair."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("qwen_install", Path(__file__).resolve().parents[1] / "install.py")
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class InstallTests(unittest.TestCase):
    def test_atomic_pair_and_recoverable_previous_pair(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "root"
            source = Path(temporary) / "source"
            root.mkdir()
            source.mkdir()
            for name in installer.FILES:
                (root / name).write_text("# old\n")
                (source / name).write_text("# new\n")
            before = installer.digest(root / "qwen-switch")
            result = installer.install(source, root, before)
            selected = (root / "qwen-switch").resolve()
            self.assertEqual(selected.read_text(), "# new\n")
            self.assertEqual(selected.with_name("qwen_resources.py").read_text(), "# new\n")
            rollback = Path(result["rollback"])
            self.assertEqual(rollback.read_text(), "# old\n")
            self.assertEqual(rollback.with_name("qwen_resources.py").read_text(), "# old\n")
            with self.assertRaisesRegex(RuntimeError, "changed"):
                installer.install(source, root, before)
            self.assertEqual((root / "qwen-switch").resolve(), selected)

    def test_invalid_source_never_replaces_current(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "root"
            source = Path(temporary) / "source"
            root.mkdir()
            source.mkdir()
            for name in installer.FILES:
                (root / name).write_text("# old\n")
                (source / name).write_text("# new\n")
            (source / "qwen_resources.py").write_text("invalid syntax !\n")
            with self.assertRaises(Exception):
                installer.install(source, root)
            self.assertFalse((root / "qwen-switch").is_symlink())
            self.assertEqual((root / "qwen-switch").read_text(), "# old\n")


if __name__ == "__main__":
    unittest.main()
