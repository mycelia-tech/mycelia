from pathlib import Path

import pytest

from mycelia_rag import config
from mycelia_rag.config import Settings


@pytest.fixture(autouse=True)
def isolate_configuration(monkeypatch):
    for name in ("RAG_MONGO_URL", "RAG_ENV_FILE"):
        monkeypatch.delenv(name, raising=False)


def test_explicit_file_ignores_working_directory_and_environment_wins(tmp_path, monkeypatch):
    working = tmp_path / "working"
    working.mkdir()
    (working / ".env").write_text("RAG_MONGO_URL=mongodb://wrong.invalid\n")
    selected = tmp_path / "selected.env"
    selected.write_text("RAG_MONGO_URL=mongodb://selected.invalid\n")
    monkeypatch.chdir(working)
    monkeypatch.setenv("RAG_ENV_FILE", str(selected))
    assert Settings().mongo_url == "mongodb://selected.invalid"
    monkeypatch.setenv("RAG_MONGO_URL", "mongodb://environment.invalid")
    assert Settings().mongo_url == "mongodb://environment.invalid"
    assert Settings(mongo_url="mongodb://constructor.invalid").mongo_url == (
        "mongodb://constructor.invalid"
    )


def test_constructor_file_takes_priority_over_selector(tmp_path, monkeypatch):
    selected = tmp_path / "selected.env"
    selected.write_text("RAG_MONGO_URL=mongodb://selected.invalid\n")
    explicit = tmp_path / "explicit.env"
    explicit.write_text("RAG_MONGO_URL=mongodb://explicit.invalid\n")
    monkeypatch.setenv("RAG_ENV_FILE", str(selected))
    assert Settings(_env_file=explicit).mongo_url == "mongodb://explicit.invalid"


def test_default_project_dotenv_ignores_chdir_and_empty_selector_disables_it(tmp_path, monkeypatch):
    project = tmp_path / "rag"
    source = project / "src" / "mycelia_rag" / "config.py"
    source.parent.mkdir(parents=True)
    source.touch()
    (project / "pyproject.toml").touch()
    (project / ".env").write_text("RAG_MONGO_URL=mongodb://legacy.invalid\n")
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / ".env").write_text("RAG_MONGO_URL=mongodb://wrong.invalid\n")
    monkeypatch.setattr(config, "__file__", str(source))
    monkeypatch.chdir(project)
    assert Settings().mongo_url == "mongodb://legacy.invalid"
    monkeypatch.chdir(elsewhere)
    assert Settings().mongo_url == "mongodb://legacy.invalid"
    monkeypatch.setenv("RAG_ENV_FILE", "")
    assert Settings().mongo_url == Settings.model_fields["mongo_url"].default


def test_installed_wheel_does_not_search_current_directory(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "__file__", str(tmp_path / "site-packages/mycelia_rag/config.py"))
    (tmp_path / ".env").write_text("RAG_MONGO_URL=mongodb://wrong.invalid\n")
    monkeypatch.chdir(tmp_path)
    assert Settings().mongo_url == Settings.model_fields["mongo_url"].default


def test_relative_selector_is_rejected(monkeypatch):
    monkeypatch.setenv("RAG_ENV_FILE", str(Path("relative.env")))
    with pytest.raises(ValueError, match="absolute path"):
        Settings()
