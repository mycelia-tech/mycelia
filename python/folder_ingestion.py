"""Explicit host-folder discovery; no fallback to Apple's protected library."""
import hashlib
import os
import re
from pathlib import Path

from discovery import AppleVoiceMemosImporter, FilesystemImporter, SourceUnavailableError, is_audio_file
from lib.resources import call_resource_once

COLLECTION = 'host_ingestion_config'
CONFIG_ID = 'audio-folder'


def load_folder_settings():
    value = call_resource_once('mongo', {
        'action': 'findOne', 'collection': COLLECTION, 'query': {'_id': CONFIG_ID},
        'options': {'maxTimeMS': 1000},
    })
    if value is None:
        return None
    path = value.get('path')
    if not isinstance(path, str) or not path.strip():
        raise ValueError('Saved audio folder is missing its path')
    return {'path': path, 'automatic': value.get('automatic') is True}


def folder_root(value):
    path = Path(value).expanduser()
    if not path.is_absolute() or path == Path(path.anchor):
        raise ValueError('Choose an absolute audio folder path, not a filesystem root')
    # Resolve the explicit folder once. Each file is checked again before upload.
    root = path.resolve(strict=True)
    if root == Path(root.anchor):
        raise ValueError("Choose an audio folder, not a filesystem root")
    if not root.is_dir():
        raise ValueError('The selected audio source is not a folder')
    with os.scandir(root):
        pass
    return root


def checked_audio_path(root, value):
    root = Path(root)
    path = Path(value)
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError('Audio path is outside the selected folder')
    relative = path.relative_to(root)
    current = root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError('Symlinked audio is not imported; select its real folder')
    resolved = path.resolve(strict=True)
    if not resolved.is_relative_to(root) or not resolved.is_file() or not is_audio_file(str(path)):
        raise ValueError('Audio must be a regular file inside the selected folder')
    return str(resolved)


def source_scope(root):
    return {'path': {'$regex': '^' + re.escape(str(root).rstrip('/') + '/')}}


class FolderFiles(FilesystemImporter):
    def should_discover(self, path):
        # Exact per-file lookup avoids the legacy corpus-wide discovery cache.
        return not call_resource_once('mongo', {
            'action': 'findOne', 'collection': 'source_files',
            'query': {'path': path},
            'options': {'maxTimeMS': 1000, 'projection': {'_id': 1}},
        })

    def discover(self):
        root = Path(self.root)
        visited = 0
        def fail(error):
            raise SourceUnavailableError(str(error))
        for directory, dirs, files in os.walk(root, followlinks=False, onerror=fail):
            dirs[:] = [name for name in dirs if not (Path(directory) / name).is_symlink()]
            for name in files:
                path = Path(directory) / name
                if not is_audio_file(str(path)) or path.is_symlink():
                    continue
                checked_audio_path(root, path)
                visited += 1
                if visited > 10000:
                    raise SourceUnavailableError('More than 10,000 audio files; select a smaller folder')
                if self.should_discover(str(path)):
                    from chunking import get_os_metadata
                    yield get_os_metadata(str(path))


class FolderLibrary(AppleVoiceMemosImporter):
    def get_sqlite_data(self):
        rows = super().get_sqlite_data()
        root = Path(self.root)
        for row in rows:
            value = row.get('ZPATH')
            if not value:
                continue
            path = Path(value)
            if path.is_absolute() or '..' in path.parts:
                raise SourceUnavailableError('Catalog audio path escapes the selected folder')
            candidate = root / path
            # Missing originals remain ordinary catalog warnings in discovery.
            if candidate.exists() or candidate.is_symlink():
                checked_audio_path(root, candidate)
        return rows


def folder_importer(value):
    root = folder_root(value)
    code = 'folder_' + hashlib.sha256(str(root).encode()).hexdigest()[:16]
    for name in ['CloudRecordings.db', 'CloudRecordings.snapshot.db']:
        database = root / name
        if database.exists() or database.is_symlink():
            if database.is_symlink() or not database.is_file():
                raise ValueError('Voice Memos database must be a regular file in the folder')
            audio = root / 'audio-original' if (root / 'audio-original').is_dir() else root
            if audio.is_symlink():
                raise ValueError('Audio subfolder must not be a symlink')
            return root, FolderLibrary(root=str(audio), db_path=str(database), code=code)
    return root, FolderFiles(root=str(root), code=code)
