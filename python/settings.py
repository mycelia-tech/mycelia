import os
from datetime import UTC, datetime

import pytz

from discovery import (
    AppleVoiceMemosImporter,
    ExtractStartTimeFromPathMixin,
    FilesystemImporter,
    Importer,
)


class GoogleCloudImporter(FilesystemImporter):
    def get_start(self, metadata) -> datetime:
        filename = os.path.basename(metadata['path'])
        tz_name = os.getenv('MYCELIA_GOOGLE_TZ', 'UTC')
        tz = pytz.timezone(tz_name)
        return tz.localize(
            datetime.strptime(  # noqa: DTZ007 - localized on the next call
                filename.split(".")[0], "%Y-%m-%d %H-%M-%S"
            ),
            is_dst=None,
        ).astimezone(UTC)


class LocalFilesystemImporter(ExtractStartTimeFromPathMixin, FilesystemImporter):
    start_group = r"(\d{2}-\d{2}-\d{4} \d{2}-\d{2})"
    strptime_format = "%m-%d-%Y %H-%M"
    timezone_code = os.getenv('MYCELIA_LOCAL_TZ', 'UTC')


APPLE_VOICEMEMOS_MODES = {"live", "manual", "staged"}


def get_apple_voicememos_mode() -> str:
    """Return the explicit Apple source boundary for this process.

    ``live`` preserves the historical behavior and reads Apple's protected
    group container. ``manual`` keeps Apple discovery out of a background
    service. ``staged`` requires explicit, readable local staging paths so
    launchd never falls back to the protected live library.
    """
    mode = os.getenv('MYCELIA_APPLE_VOICEMEMOS_MODE', 'manual').strip().lower()
    if mode not in APPLE_VOICEMEMOS_MODES:
        choices = ", ".join(sorted(APPLE_VOICEMEMOS_MODES))
        raise ValueError(
            f"MYCELIA_APPLE_VOICEMEMOS_MODE must be one of: {choices}"
        )
    return mode


def find_google_drive_evr() -> str | None:
    custom = os.getenv('MYCELIA_GOOGLE_DRIVE_ROOT')
    if custom:
        path = os.path.expanduser(custom)
        return path if os.path.isdir(path) else None

    cloud_storage = os.path.expanduser("~/Library/CloudStorage")
    if not os.path.isdir(cloud_storage):
        return None

    for folder in os.listdir(cloud_storage):
        if folder.startswith('GoogleDrive-'):
            evr_path = os.path.join(cloud_storage, folder, "My Drive", "Easy Voice Recorder")
            if os.path.isdir(evr_path):
                return evr_path
    return None


def find_apple_voicememos() -> str | None:
    custom = os.getenv('MYCELIA_APPLE_VOICEMEMOS_ROOT')
    if custom:
        # Keep explicitly configured sources registered even when macOS denies
        # access, so /health can report the failure instead of silently omitting
        # the importer.
        return os.path.abspath(os.path.expanduser(custom))

    default = os.path.expanduser("~/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings")
    return default if os.path.isdir(default) else None


def find_apple_voicememos_db(root: str) -> str:
    custom = os.getenv('MYCELIA_APPLE_VOICEMEMOS_DB')
    if custom:
        return os.path.abspath(os.path.expanduser(custom))
    return os.path.join(root, 'CloudRecordings.db')


def validate_apple_voicememos_paths(mode: str) -> None:
    if mode != 'staged':
        return
    missing = [
        name
        for name in (
            'MYCELIA_APPLE_VOICEMEMOS_ROOT',
            'MYCELIA_APPLE_VOICEMEMOS_DB',
        )
        if not os.getenv(name)
    ]
    if missing:
        raise ValueError(
            "staged Apple Voice Memos mode requires explicit staging paths: "
            + ", ".join(missing)
        )


def get_apple_voicememos_not_before() -> datetime | None:
    value = os.getenv('MYCELIA_APPLE_VOICEMEMOS_NOT_BEFORE')
    if not value:
        return None

    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(
            "MYCELIA_APPLE_VOICEMEMOS_NOT_BEFORE must be an ISO 8601 datetime"
        ) from exc

    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(
            "MYCELIA_APPLE_VOICEMEMOS_NOT_BEFORE must include a UTC offset"
        )
    return parsed.astimezone(UTC)


def find_local_audio() -> str | None:
    custom = os.getenv('MYCELIA_LOCAL_AUDIO_ROOT')
    if custom:
        path = os.path.expanduser(custom)
        return path if os.path.isdir(path) else None

    default = os.path.expanduser("~/Library/mycelia/audio")
    return default if os.path.isdir(default) else None

def build_default_importers() -> list[Importer]:
    configured: list[Importer] = []

    google_root = find_google_drive_evr()
    if google_root:
        configured.append(GoogleCloudImporter(root=google_root, code="google_drive"))

    apple_mode = get_apple_voicememos_mode()
    validate_apple_voicememos_paths(apple_mode)
    if apple_mode != 'manual':
        apple_root = find_apple_voicememos()
        if apple_root:
            configured.append(AppleVoiceMemosImporter(
                root=apple_root,
                db_path=find_apple_voicememos_db(apple_root),
                not_before=get_apple_voicememos_not_before(),
                code="apple_voicememos",
            ))

    local_root = find_local_audio()
    if local_root:
        configured.append(LocalFilesystemImporter(root=local_root, code="local"))

    return configured


if os.path.exists('./local.py'):
    from local import importers
else:
    print("No local.py found, using default importers")
    importers = build_default_importers()
