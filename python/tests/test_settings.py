import os
from pathlib import Path
from sys import path
from unittest import TestCase, main
from unittest.mock import patch

path.insert(0, str(Path(__file__).resolve().parents[1]))

import settings


class AppleVoiceMemosModeTest(TestCase):
    def test_manual_mode_is_the_safe_default(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(settings.get_apple_voicememos_mode(), "manual")

    def test_manual_mode_omits_background_apple_importer(self):
        with (
            patch.dict(
                os.environ,
                {"MYCELIA_APPLE_VOICEMEMOS_MODE": "manual"},
                clear=False,
            ),
            patch("settings.find_google_drive_evr", return_value=None),
            patch("settings.find_local_audio", return_value=None),
            patch("settings.find_apple_voicememos") as find_apple,
        ):
            configured = settings.build_default_importers()

        self.assertEqual(configured, [])
        find_apple.assert_not_called()

    def test_staged_mode_requires_explicit_audio_and_database_paths(self):
        with patch.dict(
            os.environ,
            {"MYCELIA_APPLE_VOICEMEMOS_MODE": "staged"},
            clear=True,
        ), self.assertRaisesRegex(
            ValueError,
            "requires explicit staging paths",
        ):
            settings.validate_apple_voicememos_paths("staged")

    def test_staged_mode_registers_only_the_explicit_archive(self):
        environment = {
            "MYCELIA_APPLE_VOICEMEMOS_MODE": "staged",
            "MYCELIA_APPLE_VOICEMEMOS_ROOT": "/archive/audio-original",
            "MYCELIA_APPLE_VOICEMEMOS_DB": "/staging/CloudRecordings.db",
        }
        with (
            patch.dict(os.environ, environment, clear=False),
            patch("settings.find_google_drive_evr", return_value=None),
            patch("settings.find_local_audio", return_value=None),
        ):
            configured = settings.build_default_importers()

        self.assertEqual(len(configured), 1)
        self.assertEqual(configured[0].root, environment[
            "MYCELIA_APPLE_VOICEMEMOS_ROOT"
        ])
        self.assertEqual(configured[0].db_path, environment[
            "MYCELIA_APPLE_VOICEMEMOS_DB"
        ])

    def test_invalid_mode_is_rejected(self):
        with patch.dict(
            os.environ,
            {"MYCELIA_APPLE_VOICEMEMOS_MODE": "background-magic"},
            clear=False,
        ), self.assertRaisesRegex(ValueError, "must be one of"):
            settings.get_apple_voicememos_mode()


if __name__ == "__main__":
    main()
