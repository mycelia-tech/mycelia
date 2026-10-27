"""Exercise launcher environment selection without starting services or Python."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from unittest import TestCase, main


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
LAUNCHERS = {
    "run-ingestion-service.sh": "ingestion_server.py",
    "run-voice-memos-importer.sh": "voice_memos_bridge_server.py",
    "run-audio-pipeline.sh": "daemon.py",
}


class HostAudioLauncherTest(TestCase):
    def run_launcher(self, name, override):
        with tempfile.TemporaryDirectory() as temporary:
            # Spaces also exercise quoting in the resolved environment argument.
            root = Path(temporary).resolve() / "checkout with spaces"
            (root / "scripts").mkdir(parents=True)
            (root / "python").mkdir()
            (root / ".env").write_text(
                "STT_SERVER_URL=http://example.invalid\nPROXY_API_KEY=test-only\n",
                encoding="utf-8",
            )
            script = root / "scripts" / name
            shutil.copyfile(REPOSITORY_ROOT / "scripts" / name, script)
            harness = root / "harness.sh"
            capture = root / "arguments"
            harness.write_text(
                "uv() { return 0; }\n"
                "ffmpeg() { return 0; }\n"
                "ffprobe() { return 0; }\n"
                "docker() { return 0; }\n"
                "curl() { return 0; }\n"
                # Shadow exec so even launchers with a fixed PATH cannot start
                # real uv, Docker, an importer or a network request in this test.
                "exec() {\n"
                "  printf '%s\\0' \"$@\" > \"$MYCELIA_RUNNER_CAPTURE\"\n"
                "  pwd > \"$MYCELIA_RUNNER_CAPTURE.cwd\"\n"
                "}\n",
                encoding="utf-8",
            )
            environment = {
                key: value for key, value in os.environ.items()
                if key not in {"UV_PROJECT_ENVIRONMENT", "UV_BIN", "BASH_ENV"}
            }
            environment.update({
                "BASH_ENV": str(harness),
                "MYCELIA_RUNNER_CAPTURE": str(capture),
            })
            if override is not None:
                environment["UV_PROJECT_ENVIRONMENT"] = override
            subprocess.run(
                ["/bin/bash", str(script)],
                env=environment,
                capture_output=True,
                text=True,
                timeout=10,
                check=True,
            )
            arguments = capture.read_bytes().decode().rstrip("\0").split("\0")
            self.assertEqual(arguments[0], "env")
            self.assertIn(
                f"UV_PROJECT_ENVIRONMENT={override or root / 'python/.venv'}",
                arguments,
            )
            self.assertEqual(arguments[-1], LAUNCHERS[name])
            self.assertEqual(
                Path(str(capture) + ".cwd").read_text().strip(),
                str(root / "python"),
            )

    def test_default_environment_persists_with_checkout(self):
        for name in LAUNCHERS:
            with self.subTest(launcher=name):
                self.run_launcher(name, None)

    def test_explicit_environment_is_preserved(self):
        for name in LAUNCHERS:
            with self.subTest(launcher=name):
                self.run_launcher(name, "/custom persistent/env with spaces")


if __name__ == "__main__":
    main()
