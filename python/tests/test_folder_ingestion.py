"""Folder selection is a strict import boundary, including queued jobs."""
import re
import tempfile
from contextlib import nullcontext
from pathlib import Path
from unittest import TestCase
from unittest.mock import Mock, patch

import daemon
import ingestion_server as server
from folder_ingestion import FolderLibrary, checked_audio_path, folder_importer, source_scope

SUCCESS = dict(attempted=0, succeeded=0, failed=0, remaining=0, cached_errors=0)


class FolderBoundaryTest(TestCase):
    def test_folder_discovery_excludes_symlinks_and_neighbor_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve() / 'selected'
            root.mkdir()
            audio = root / 'memo.m4a'
            audio.touch()
            outside = root.parent / 'outside.m4a'
            outside.touch()
            (root / 'link.m4a').symlink_to(outside)
            resolved, importer = folder_importer(str(root))
            with patch.object(importer, 'should_discover', return_value=True), patch('chunking.get_os_metadata', side_effect=lambda p: {'path': p}):
                self.assertEqual(list(importer.discover()), [{'path': str(audio)}])
            with self.assertRaises(ValueError):
                checked_audio_path(resolved, root / 'link.m4a')
            with self.assertRaises(ValueError):
                checked_audio_path(resolved, outside)
            pattern = source_scope(resolved)['path']['$regex']
            self.assertTrue(re.match(pattern, str(audio)))
            self.assertFalse(re.match(pattern, str(root) + '-other/memo.m4a'))

    def test_catalog_does_not_escape_folder(self):
        importer = FolderLibrary(root='/selected', code='fixture', db_path='/selected/CloudRecordings.db')
        for value in ('../outside.m4a', '/outside.m4a'):
            with self.subTest(value=value), patch('discovery.AppleVoiceMemosImporter.get_sqlite_data', return_value=[{'ZPATH': value}]):
                with self.assertRaisesRegex(RuntimeError, 'escapes'):
                    importer.get_sqlite_data()

    def test_upload_rechecks_scope_even_if_database_returns_wrong_path(self):
        calls = []
        def resource(_name, body):
            calls.append(body)
            if body['action'] == 'count':
                return 1
            if body['action'] == 'find':
                return [{'_id': 'fixture', 'path': '/outside/audio.m4a', 'platform': {}}]
            return {}
        with patch('daemon.call_resource', side_effect=resource), patch.object(daemon.unknown_importer, 'upload') as upload:
            result = daemon.ingests_missing_sources.__wrapped__(limit=20, source_root=Path('/selected'))
        upload.assert_not_called()
        self.assertEqual(result['failed'], 1)
        for request in calls:
            if request['action'] in ('count', 'find'):
                self.assertEqual(request['query']['path'], source_scope('/selected')['path'])
                self.assertNotIn('$or', request['query'])

    def test_selected_folder_is_only_discovered_source_and_job_path_is_captured(self):
        importer = Mock(last_warning=None)
        importer.run.return_value = 2
        with patch('ingestion_server.load_folder_settings', return_value={'path': '/later', 'automatic': True}), patch('ingestion_server.folder_importer', return_value=(Path('/selected'), importer)) as selected, patch('ingestion_server.ingestion_lock', return_value=nullcontext()), patch('ingestion_server.import_new_files') as legacy, patch('ingestion_server.ingests_missing_sources', return_value=SUCCESS) as ingest, patch('ingestion_server.call_resource'):
            server.run_ingestion_cycle(20, 'job', '/selected')
            selected.assert_called_once_with('/selected')
            legacy.assert_not_called()
            ingest.assert_called_once_with(limit=20, source_root=Path('/selected'), progress_callback=server.update_ingestion_progress)

    def test_manual_folder_does_not_auto_import_and_config_error_has_no_fallback(self):
        with patch('ingestion_server.load_folder_settings', return_value={'path': '/selected', 'automatic': False}) as settings, patch('ingestion_server.import_new_files') as legacy, patch('ingestion_server.folder_importer') as selected:
            with patch.object(server, 'last_cycle', {'status': 'completed', 'finishedAt': 'previous'}):
                result = server.run_ingestion_cycle(20)
                self.assertEqual(result['finishedAt'], 'previous')
            selected.assert_not_called()
            settings.side_effect = RuntimeError('settings unavailable')
            with self.assertRaisesRegex(RuntimeError, 'settings unavailable'):
                server.run_ingestion_cycle(20)
            legacy.assert_not_called()
