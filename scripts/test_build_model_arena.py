#!/usr/bin/env python3
"""Stdlib tests for the Arena snapshot builder. No duckdb required."""
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('build_model_arena', ROOT / 'build-model-arena.py')
assert SPEC and SPEC.loader
BUILD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILD)


class CanonicalTests(unittest.TestCase):
    def test_keeps_version_dates_distinct(self) -> None:
        self.assertEqual(BUILD.canonical('DeepSeek-V4.1-Flash-20261017 (Max)'), 'deepseekv41flash20261017')
        self.assertEqual(BUILD.canonical('DeepSeek-V4.1-Flash-20260910 (Max)'), 'deepseekv41flash20260910')
        self.assertNotEqual(
            BUILD.canonical('DeepSeek-V4.1-Flash-20261017 (Max)'),
            BUILD.canonical('DeepSeek-V4.1-Flash-20260910 (Max)'),
        )
        self.assertEqual(BUILD.canonical('GPT-4.1 (2025-04-14)'), 'gpt4120250414')


class SourceDirTests(unittest.TestCase):
    def test_isolates_custom_cache_root_by_revision(self) -> None:
        revision = 'a' * 40
        self.assertEqual(BUILD.source_dir_for(Path('/cache'), revision), Path('/cache') / revision)
        self.assertEqual(BUILD.source_dir_for(None, revision), Path('.scratch') / 'arena-source' / revision)


class RevisionTests(unittest.TestCase):
    def run_latest(self, tmp: str, sha: str, calls: list[str], download=None) -> None:
        """Run main() --revision latest against a tmp cache; nothing may land in the repo."""
        argv = [
            'build-model-arena.py', '--revision', 'latest',
            '--source-dir', str(Path(tmp) / 'cache'), '--output', str(Path(tmp) / 'out.json'),
        ]
        metadata = json.dumps({'sha': sha, 'lastModified': '2026-01-02T00:00:00.000Z'})
        if download is None:
            download = lambda url, path: calls.append(url)
        with mock.patch.object(sys, 'argv', argv), \
                mock.patch.object(BUILD, 'download_json', return_value=metadata), \
                mock.patch.object(BUILD, 'download', side_effect=download):
            BUILD.main()

    def test_rejects_non_hex_and_path_like_sha(self) -> None:
        with self.assertRaises(ValueError):
            BUILD.require_full_revision('/tmp/abs')
        with self.assertRaises(ValueError):
            BUILD.require_full_revision('../../tmp/evil')
        with self.assertRaises(ValueError):
            BUILD.require_full_revision('not-a-commit')
        revision = 'c' * 40
        self.assertEqual(BUILD.require_full_revision(revision), revision)

    def test_latest_rejects_bad_sha_before_caching_or_downloading(self) -> None:
        for sha in ('/tmp/abs', '../../tmp/evil', 'not-a-commit'):
            with self.subTest(sha=sha), tempfile.TemporaryDirectory() as tmp:
                calls: list[str] = []
                with self.assertRaises(ValueError):
                    self.run_latest(tmp, sha, calls)
                self.assertEqual(calls, [])
                self.assertFalse((Path(tmp) / 'cache').exists())

    def test_latest_downloads_into_the_resolved_sha_cache(self) -> None:
        sha = 'd' * 40
        sentinel = RuntimeError('stop after the first download')
        calls: list[tuple[str, Path]] = []

        def fail_first(url: str, path: Path) -> None:
            calls.append((url, path))
            raise sentinel

        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(RuntimeError) as caught:
                self.run_latest(tmp, sha, calls, fail_first)
            self.assertIs(caught.exception, sentinel)
            self.assertEqual(len(calls), 1)
            url, path = calls[0]
            self.assertIn(f'/resolve/{sha}/', url)
            self.assertEqual(Path(path).parent, Path(tmp) / 'cache' / sha)
            self.assertEqual(Path(path).name, f'{next(iter(BUILD.ARENAS))}.parquet')
            self.assertTrue((Path(tmp) / 'cache' / sha).is_dir())


class LastModifiedTests(unittest.TestCase):
    def test_new_revision_does_not_reuse_the_pinned_timestamp(self) -> None:
        other = 'b' * 40
        fetched: list[str] = []

        def fetch(revision: str) -> str:
            fetched.append(revision)
            return '2026-01-02T00:00:00.000Z'

        self.assertEqual(BUILD.last_modified_for(other, None, fetch), '2026-01-02T00:00:00.000Z')
        self.assertEqual(fetched, [other])
        self.assertEqual(BUILD.last_modified_for(BUILD.DEFAULT_REVISION, None, fetch), BUILD.DEFAULT_LAST_MODIFIED)
        self.assertEqual(BUILD.last_modified_for(other, 'explicit', fetch), 'explicit')
        self.assertNotEqual(BUILD.last_modified_for(other, None, fetch), BUILD.DEFAULT_LAST_MODIFIED)


class FetchAllTests(unittest.TestCase):
    def test_builder_does_not_require_pandas_dataframes(self) -> None:
        source = (ROOT / 'build-model-arena.py').read_text(encoding='utf-8')
        self.assertNotIn('fetchdf', source)
        self.assertIn('.fetchall()', source)


if __name__ == '__main__':
    unittest.main()
