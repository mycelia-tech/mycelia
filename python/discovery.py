import json
import logging
import os
import platform
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import threading
from collections.abc import Iterable
from contextlib import contextmanager
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from functools import cached_property
from pathlib import Path
from typing import TypedDict

import humanize
import paramiko
import pytz
from tqdm import tqdm

from chunking import get_os_metadata, get_tmp_dir, ingest_source
from lib.resources import call_resource
from utils import lazy


def extract_device_info(filepath: str) -> dict | None:
    """
    Extract device info from m4a file using ffprobe.
    Returns dict with device_type, encoder, os_version, etc.
    """
    if not os.path.exists(filepath):
        return None
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", filepath],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        if result.returncode != 0:
            return None

        data = json.loads(result.stdout)
        tags = data.get("format", {}).get("tags", {})
        encoder = tags.get("encoder", "")

        if not encoder:
            return None

        # Parse device type from encoder string
        # Examples:
        # - "com.apple.VoiceMemos (Watch Version 26.1 (Build 23S37))"
        # - "com.apple.VoiceMemos (iPhone Version 18.3 (Build 22D5034e))"
        # - "com.apple.VoiceMemos (iPad Version 15.4.1 (Build 24E263))"
        # - "com.apple.VoiceMemos (MacBook Pro (null))"
        # - "com.apple.VoiceMemos (iOS 13.1.2)"

        device_info = {
            "encoder": encoder,
            "device_type": "unknown",
        }

        if "Watch" in encoder:
            device_info["device_type"] = "apple_watch"
        elif "iPhone" in encoder:
            device_info["device_type"] = "iphone"
        elif "iPad" in encoder:
            device_info["device_type"] = "ipad"
        elif "MacBook" in encoder or "MBP" in encoder or "Mac" in encoder:
            device_info["device_type"] = "mac"
        elif "iOS" in encoder:
            device_info["device_type"] = "iphone"  # iOS without device name is usually iPhone

        return device_info

    except (subprocess.SubprocessError, json.JSONDecodeError, subprocess.TimeoutExpired, FileNotFoundError):
        return None

class Skip(Exception):
    pass


class SourceUnavailableError(RuntimeError):
    """A configured discovery source could not be read."""

class Metadata(TypedDict):
    path: str

_IS_AUDIO_RE = re.compile(r"\.(m4a|mp3|wav|opus)$", re.IGNORECASE)



_known_discovered_cache = lazy(lambda: {d['path'] for d in call_resource('mongo', {
    "action": "find",
    "collection": "source_files",
    "query": {
        "path": {"$exists": True}
    },
    "projection": {"path": 1, "_id": 0},
})})


def is_audio_file(path: str) -> bool:
    return bool(_IS_AUDIO_RE.search(path))

def is_discovered(path: str) -> bool:
    if path in _known_discovered_cache:
        return True
    found = bool(call_resource('mongo', {
        "action": "findOne",
        "collection": "source_files",
        "query": {"path": path}
    }))
    if found:
        _known_discovered_cache.add(path)
    return found

class Importer:
    logger = logging.getLogger('discovery')
    lock: threading.Lock
    root: str
    code: str

    def __init__(self, code: str, **kwargs):
        self.code = code
        for k, v in kwargs.items():
            setattr(self, k, v)
        self.lock = threading.Lock()

    def discover(self) -> Iterable[Metadata]:
        raise NotImplementedError

    def get_start(self, metadata: Metadata) -> datetime:
        raise NotImplementedError

    def get_platform(self) -> dict:
        return {
            "system": platform.system(),
            "node": platform.node(),
            "importer": self.code,
        }

    def ingest(self, metadata: Metadata):
        metadata.update({
            "ingested": False,
            "platform": self.get_platform(),
            "start": self.get_start(metadata)
        })
        self.logger.debug("adding %s to source_files", metadata['path'])
        call_resource('mongo', {
            "action": "insertOne",
            "collection": "source_files",
            "doc": metadata
        })

    def run(self) -> int:
        with self.lock:
            new_files = list(self.discover())
            if new_files:
                self.logger.info("discovered %s new files in '%s'", len(new_files), self.root)
                for item in new_files:
                    self.ingest(item)
            else:
                self.logger.info("no new files found in '%s'", self.root)
            return len(new_files)

    def upload(self, source: dict):
        ingest_source(source)


class FilesystemImporter(Importer):
    def should_discover(self, path: str) -> bool:
        return is_audio_file(path) and not is_discovered(path)

    def get_start(self, metadata: Metadata) -> datetime:
        return metadata["created"]

    def discover(self) -> Iterable[Metadata]:
        for dirpath, _, filenames in os.walk(self.root):
            for filename in filenames:
                path = os.path.join(dirpath, filename)
                if self.should_discover(path):
                    yield get_os_metadata(path)


# Apple reference date (Jan 1 2001 00:00:00 GMT)
APPLE_REFERENCE_DATE = 978307200

def apple_date_to_datetime(apple_date):
    return datetime.fromtimestamp(APPLE_REFERENCE_DATE + apple_date, tz=UTC)


class AppleVoiceMemosImporter(Importer):
    db_path: str
    not_before: datetime | None = None
    last_warning: str | None = None

    def __init__(
        self,
        *,
        root: str,
        code: str,
        db_path: str | None = None,
        not_before: datetime | None = None,
    ):
        super().__init__(code=code, root=root)
        self.db_path = db_path or os.path.join(root, "CloudRecordings.db")
        self.not_before = not_before

    def get_start(self, metadata: Metadata):
        return apple_date_to_datetime(metadata["voicememo"]["ZDATE"])

    def get_sqlite_data(self):
        db_path = os.path.abspath(os.path.expanduser(self.db_path))
        uri = f"{Path(db_path).as_uri()}?mode=ro"
        try:
            # Do not use immutable=1: the live Voice Memos database uses WAL,
            # and recent recordings may only exist in its sidecar files.
            db = sqlite3.connect(uri, uri=True)
        except sqlite3.Error as exc:
            raise SourceUnavailableError(
                f"Apple Voice Memos database is unavailable at {db_path}: {exc}. "
                "Publish a readable archive snapshot with "
                "scripts/refresh-voice-memos-staging.sh, or set "
                "MYCELIA_APPLE_VOICEMEMOS_ROOT and "
                "MYCELIA_APPLE_VOICEMEMOS_DB to verified staging paths."
            ) from exc
        try:
            cursor = db.cursor()
            query = "SELECT * FROM ZCLOUDRECORDING"
            params: tuple[float, ...] = ()
            if self.not_before is not None:
                query += " WHERE ZDATE >= ?"
                params = (
                    self.not_before.astimezone(UTC).timestamp()
                    - APPLE_REFERENCE_DATE,
                )
            cursor.execute(query, params)
            field_names = [d for d, *_ in cursor.description]
            return [dict(zip(field_names, row)) for row in cursor.fetchall()]
        except sqlite3.Error as exc:
            raise SourceUnavailableError(
                f"Apple Voice Memos database could not be queried at "
                f"{db_path}: {exc}"
            ) from exc
        finally:
            db.close()

    @staticmethod
    def get_known_identities(
        candidate_paths: set[str],
        candidate_unique_ids: set[str],
    ) -> list[dict]:
        """Refresh identities for this catalog without relying on find defaults."""
        clauses = []
        if candidate_paths:
            clauses.append({"path": {"$in": sorted(candidate_paths)}})
        if candidate_unique_ids:
            clauses.append({
                "voicememo.ZUNIQUEID": {
                    "$in": sorted(candidate_unique_ids),
                }
            })

        if not clauses:
            return []

        records = []
        after_id = None
        while True:
            query = {"$or": clauses}
            if after_id is not None:
                query["_id"] = {"$gt": after_id}
            page = call_resource('mongo', {
                "action": "find",
                "collection": "source_files",
                "query": query,
                "options": {
                    "projection": {
                        "path": 1,
                        "voicememo.ZUNIQUEID": 1,
                        "ingested": 1,
                        "_id": 1,
                    },
                    "sort": {"_id": 1},
                    "limit": 1000,
                },
            })
            records.extend(page)
            if len(page) < 1000:
                return records
            # Existing duplicates can outnumber the candidate identities.
            after_id = page[-1]["_id"]

    @staticmethod
    def repair_pending_path(source: dict, path: str) -> str | None:
        """Rebind a pending identity without clearing its cached failure."""
        if source.get("ingested") is not False or source.get("path") == path:
            return None
        try:
            if not Path(path).is_file():
                return f"Replacement is not a readable regular file: {path}"
            with open(path, "rb") as stream:
                if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                    return f"Replacement is not a regular file: {path}"
        except OSError as exc:
            return f"Replacement cannot be read: {path} ({exc})"

        result = call_resource('mongo', {
            "action": "updateOne",
            "collection": "source_files",
            "query": {
                "_id": source["_id"],
                "voicememo.ZUNIQUEID": source["voicememo"]["ZUNIQUEID"],
                "path": source.get("path"),
                "ingested": False,
            },
            "update": {"$set": {"path": path}},
        })
        if result.get("matchedCount") != 1:
            return f"Pending recording changed during path repair: {source['_id']}"
        source["path"] = path
        return None

    def discover(self) -> Iterable[Metadata]:
        self.last_warning = None
        root = os.path.abspath(os.path.expanduser(self.root))
        try:
            with os.scandir(root):
                pass
        except OSError as exc:
            raise SourceUnavailableError(
                f"Apple Voice Memos audio folder is unavailable at {root}: "
                f"{exc}"
            ) from exc

        sqlite_data = self.get_sqlite_data()
        total_memos = len(sqlite_data)
        candidate_paths = {
            os.path.join(root, memo["ZPATH"])
            for memo in sqlite_data
            if memo.get("ZPATH")
        }
        candidate_unique_ids = {
            memo["ZUNIQUEID"]
            for memo in sqlite_data
            if memo.get("ZUNIQUEID")
        }
        catalog_paths_by_uuid: dict[str, set[str]] = {}
        for memo in sqlite_data:
            if memo.get("ZUNIQUEID") and memo.get("ZPATH"):
                catalog_paths_by_uuid.setdefault(memo["ZUNIQUEID"], set()).add(
                    os.path.join(root, memo["ZPATH"])
                )
        ambiguous_catalog_ids = {
            unique_id for unique_id, paths in catalog_paths_by_uuid.items()
            if len(paths) > 1
        }
        known_records = self.get_known_identities(
            candidate_paths,
            candidate_unique_ids,
        )
        known_paths = {record["path"] for record in known_records if record.get("path")}
        records_by_uuid: dict[str, list[dict]] = {}
        for record in known_records:
            unique_id = record.get("voicememo", {}).get("ZUNIQUEID")
            if unique_id:
                records_by_uuid.setdefault(unique_id, []).append(record)
        known_unique_ids = set(records_by_uuid)
        missing_media: list[str] = []
        recovery_warnings: list[str] = []
        warned_catalog_ids: set[str] = set()

        with tqdm(
            total=total_memos,
            desc=f"Discovering {self.code}",
            unit="files",
            disable=not sys.stderr.isatty(),
        ) as pbar:
            for memo in sqlite_data:
                try:
                    if not memo["ZPATH"]:
                        continue
                    path = os.path.join(root, memo["ZPATH"])
                    unique_id = memo.get("ZUNIQUEID")

                    if unique_id in ambiguous_catalog_ids:
                        if unique_id not in warned_catalog_ids:
                            recovery_warnings.append(
                                f"Ambiguous Voice Memos catalog paths for UUID: {unique_id}"
                            )
                            warned_catalog_ids.add(unique_id)
                        continue

                    matches = records_by_uuid.get(unique_id, [])
                    if matches:
                        if len(matches) > 1 or (
                            path in known_paths and matches[0].get("path") != path
                        ):
                            recovery_warnings.append(
                                f"Ambiguous existing Voice Memo identity: {unique_id}"
                            )
                        else:
                            warning = self.repair_pending_path(matches[0], path)
                            if warning:
                                recovery_warnings.append(warning)
                            if matches[0].get("path"):
                                known_paths.add(matches[0]["path"])
                        continue

                    if path in known_paths or (
                        unique_id and unique_id in known_unique_ids
                    ):
                        continue

                    try:
                        os_metadata = get_os_metadata(path)
                    except OSError as exc:
                        missing_media.append(
                            f"{os.path.basename(path)} ({exc.strerror or exc})"
                        )
                        continue

                    metadata = {
                        **os_metadata,
                        "voicememo": {
                            "ZENCRYPTEDTITLE": memo["ZENCRYPTEDTITLE"],
                            "ZUNIQUEID": unique_id,
                            "ZDATE": memo["ZDATE"],
                        },
                        "duration": memo["ZDURATION"],
                    }

                    # Extract device info from m4a file
                    device_info = extract_device_info(path)
                    if device_info:
                        metadata["device"] = device_info

                    # Keep the in-cycle identity sets current as records are
                    # yielded, preventing duplicates inside a backup catalog.
                    known_paths.add(path)
                    if unique_id:
                        known_unique_ids.add(unique_id)
                    yield metadata
                finally:
                    pbar.update(1)

        warnings = []
        if missing_media:
            examples = ", ".join(missing_media[:3])
            warnings.append(
                f"{len(missing_media)} Voice Memos catalog entries could not "
                f"be read from {root}; examples: {examples}"
            )
        if recovery_warnings:
            warnings.append(
                f"{len(recovery_warnings)} Voice Memos recovery warnings; "
                + "; ".join(recovery_warnings[:3])
            )
        if warnings:
            self.last_warning = "; ".join(warnings)
            self.logger.warning(self.last_warning)


class SshFilesystemImporter(FilesystemImporter):
    host: str
    port: int
    username: str
    last_modified_threshold: timedelta = timedelta(minutes=1)
    recursive: bool = True
    delete_after_upload: bool = False

    def get_platform(self):
        platform = super().get_platform()
        platform.update({
            "host": self.host,
        })
        return platform

    def iterate_remote_files(self) -> Iterable[tuple[str, paramiko.SFTPAttributes]]:
        with self.clients() as (_ssh, sftp):
            stack = [self.root]
            while stack:
                current_path = stack.pop()
                for entry in sftp.listdir_attr(current_path):
                    full_path = f"{current_path}/{entry.filename}" if not current_path.endswith("/") else f"{current_path}{entry.filename}"
                    if not stat.S_ISDIR(entry.st_mode):
                        yield full_path, entry
                    elif self.recursive:
                        stack.append(full_path)

    @contextmanager
    def clients(self) -> tuple[paramiko.SSHClient, paramiko.SFTPClient]:
        with paramiko.SSHClient() as ssh:
            ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            ssh.connect(self.host, port=self.port, username=self.username, allow_agent=True, look_for_keys=True, timeout=10)
            with ssh.open_sftp() as sftp:
                yield ssh, sftp

    def should_process(self, path: str, attributes: paramiko.SFTPAttributes) -> bool:
        if not is_audio_file(path):
            return False

        if self.last_modified_threshold:
            last_modified = datetime.fromtimestamp(attributes.st_mtime, tz=UTC)
            delta = datetime.now(UTC) - last_modified
            if delta < self.last_modified_threshold:
                print(f"Skipping {path} because it was modified too recently ({delta.total_seconds()} seconds ago)")
                return False

        return not is_discovered(path)

    def discover(self):
        for path, attributes in self.iterate_remote_files():
            if not self.should_process(path, attributes):
                continue
            yield {
                "created": datetime.fromtimestamp(attributes.st_mtime, tz=UTC),
                "modified": datetime.fromtimestamp(attributes.st_mtime, tz=UTC),
                "path": path,
                "size": attributes.st_size,
            }

    def upload(self, source: dict):
        remote_path = source["path"]
        local_dir = get_tmp_dir(remote_path)
        try:
            os.makedirs(local_dir, exist_ok=True)
            local_path = os.path.join(local_dir, os.path.basename(remote_path))
            with self.clients() as (_ssh, sftp):
                print(f"Downloading {humanize.naturalsize(source['size'])} from {self.host}")
                total_size = int(source.get("size") or 0)
                description = os.path.basename(remote_path)
                with tqdm(total=total_size if total_size > 0 else None, unit='B', unit_scale=True, desc=f"{self.host}:{description}") as progress_bar:
                    def handle_progress(transferred, total):
                        if progress_bar.total != total and total:
                            progress_bar.total = total
                        progress_bar.update(transferred - progress_bar.n)
                    sftp.get(remote_path, local_path, callback=handle_progress)
            local_source = deepcopy(source)
            local_source["path"] = local_path
            super().upload(local_source)
            if self.delete_after_upload:
                with self.clients() as (_ssh, sftp):
                    sftp.remove(remote_path)

                    print(f"Cleaned up {humanize.naturalsize(source['size'])} from {self.host}")
        finally:
            if os.path.exists(local_path):
                os.remove(local_path)
            shutil.rmtree(local_dir, ignore_errors=True)


class ExtractStartTimeFromPathMixin:
    timezone_code: str = 'UTC'
    start_group: str
    strptime_format: str

    @cached_property
    def timezone(self) -> pytz.timezone:
        return pytz.timezone(self.timezone_code)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.start_group_re = re.compile(self.start_group)
        assert self.start_group_re.groups == 1, "Start group must be a single group"

    def get_start(self, metadata: Metadata) -> datetime:
        match = self.start_group_re.search(metadata["path"])
        if not match:
            raise Skip(f"Could not find start time in filename {metadata['path']}")
        return self.timezone.localize(
            datetime.strptime(  # noqa: DTZ007 - localized on the next call
                match.group(1), self.strptime_format
            ),
            is_dst=None,
        ).astimezone(pytz.UTC)
