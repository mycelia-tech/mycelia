"""Explicit environment loading for Python entrypoints; imports do not alter env."""
import os
from pathlib import Path
from urllib.parse import urljoin, urlparse

import dotenv

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


def load_environment(*, default_url: str | None = None) -> None:
    configured = os.getenv("MYCELIA_ENV_FILE")
    location = Path(configured).expanduser() if configured else REPOSITORY_ROOT / ".env"
    if not location.is_absolute():
        location = REPOSITORY_ROOT / location
    if configured and not location.is_file():
        raise ValueError("MYCELIA_ENV_FILE does not identify a readable file")
    if location.is_file():
        dotenv.load_dotenv(location, override=False)
    if default_url is not None:
        os.environ.setdefault("MYCELIA_URL", default_url)


def env(name: str, default: str | None = None) -> str | None:
    return os.getenv(name, default)


def get_url(*path: str) -> str:
    base = env("MYCELIA_URL") or ""
    parsed = urlparse(base)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("MYCELIA_URL must be an absolute HTTP(S) URL")
    return urljoin(base.rstrip("/") + "/", "/".join(path))


def allow_insecure_transport() -> bool:
    return (env("MYCELIA_URL") or "").startswith("http://") or env("ALLOW_INSECURE_TRANSPORT", "false") == "true"
