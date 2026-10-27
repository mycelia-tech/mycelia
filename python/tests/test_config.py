import os
import tempfile
from pathlib import Path
from sys import path
from unittest import TestCase
from unittest.mock import Mock, patch

path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib import api, config
import settings


class ConfigTest(TestCase):
    def test_http_allowance_never_disables_tls_certificate_verification(self):
        with patch.dict(os.environ, {"MYCELIA_URL": "http://localhost:3210", "ALLOW_INSECURE_TRANSPORT": "true"}):
            session = api.create_session()
            self.assertTrue(session.verify)
            session.close()

    def test_importer_override_is_relative_to_python_not_working_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "fixture.py").write_text("importers = ['fixture']\n")
            with patch.object(settings, "__file__", str(root / "settings.py")), patch.dict(os.environ, {
                "MYCELIA_IMPORTERS_FILE": "fixture.py",
            }):
                self.assertEqual(settings.load_importers(), ["fixture"])

    def test_process_environment_wins_and_explicit_dotenv_is_cwd_independent(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "fixture.env").write_text("MYCELIA_URL=https://file.invalid\nMYCELIA_CLIENT_ID=fixture\n")
            with patch.object(config, "REPOSITORY_ROOT", root), patch.dict(os.environ, {
                "MYCELIA_ENV_FILE": "fixture.env", "MYCELIA_URL": "https://process.invalid",
            }, clear=True):
                config.load_environment(default_url="http://localhost:3210")
                self.assertEqual(config.get_url("api", "resource"), "https://process.invalid/api/resource")
                self.assertEqual(config.env("MYCELIA_CLIENT_ID"), "fixture")

    def test_missing_explicit_dotenv_and_invalid_url_fail_loudly(self):
        with patch.dict(os.environ, {"MYCELIA_ENV_FILE": "/nonexistent/mycelia.env"}, clear=True):
            with self.assertRaises(ValueError):
                config.load_environment()
            with self.assertRaises(ValueError):
                config.get_url("api")

    def test_auth_reads_current_environment_and_always_has_deadline(self):
        response = Mock()
        response.json.return_value = {"access_token": "fixture-access"}
        with patch.dict(os.environ, {
            "MYCELIA_URL": "https://fixture.invalid", "MYCELIA_CLIENT_ID": "fixture", "MYCELIA_TOKEN": "fixture-secret",
        }, clear=True), patch("lib.api.requests.post", return_value=response) as post:
            self.assertEqual(api.exchange_api_key_for_jwt(timeout=None), "fixture-access")
            self.assertEqual(post.call_args.kwargs["timeout"], (3.0, 15.0))
            self.assertTrue(post.call_args.kwargs["verify"])
