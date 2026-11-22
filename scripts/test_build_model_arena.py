#!/usr/bin/env python3
"""Stdlib tests for the Arena snapshot builder. No duckdb required."""
from __future__ import annotations

import importlib.util
import unittest
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
    def test_rejects_non_hex_and_path_like_sha(self) -> None:
        with self.assertRaises(ValueError):
            BUILD.require_full_revision('/tmp/abs')
        with self.assertRaises(ValueError):
            BUILD.require_full_revision('../../tmp/evil')
        with self.assertRaises(ValueError):
            BUILD.require_full_revision('not-a-commit')
        revision = 'c' * 40
        self.assertEqual(BUILD.require_full_revision(revision), revision)
        source = (ROOT / 'build-model-arena.py').read_text(encoding='utf-8')
        self.assertIn("require_full_revision(metadata['sha'])", source)


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
