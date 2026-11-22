#!/usr/bin/env python3
"""Build src/model-arena.json from LMArena's official versioned Parquet data.

Requires Python 3 and duckdb. No generated-file step needs Node or network at runtime.

  python scripts/build-model-arena.py --source-dir .scratch/arena-source
  python scripts/build-model-arena.py --revision latest --base-url https://hf-mirror.com

Pin --revision to a full dataset commit for a reproducible document. The mirror is
only a transport alternative; provenance always points to the official dataset.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import duckdb

DATASET = 'lmarena-ai/leaderboard-dataset'
DEFAULT_REVISION = 'ad6131670bd01ed74a552172c1afee8c0db20047'
DEFAULT_LAST_MODIFIED = '2026-11-22T04:02:06.000Z'
ARENAS = {
    'text_style_control': 'text',
    'webdev': 'webdev',
    'vision_style_control': 'vision',
    'document_style_control': 'document',
    'search_style_control': 'search',
    'agent_capability': 'agent',
}
# Keep the recommendation document compact; rankCount retains the full board size.
TOP_PER_BOARD = 20
USED_CATEGORIES = {
    'text': {
        'overall', 'coding', 'creative_writing', 'hard_prompts',
        'instruction_following', 'multi_turn', 'longer_query', 'math', 'chinese',
        'industry_software_and_it_services',
        'industry_writing_and_literature_and_language',
    },
    'webdev': {'overall', 'webdev-react', 'webdev-html', 'image_to_webdev'},
    'vision': {'overall', 'ocr', 'diagram', 'captioning', 'creative_writing_vision'},
    'document': {'overall'},
    'search': {'overall'},
    'agent': {'overall', 'code', 'work', 'chat'},
}
EFFORT_LABELS = {
    'max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'thinking',
    'non-reasoning', 'non reasoning', 'reasoning', 'off',
}
ALIASES = {
    # Official hosted aliases whose underlying model is documented by the provider.
    # Do not map deepseek-flash here: the current 1017 endpoint and the older
    # Arena V4.1 Flash entry are different model revisions.
    'k31pro': 'kimik31pro',
    'k31prohighspeed': 'kimik31pro',
    'k3': 'kimik3',
    'k3256k': 'kimik3',
}


def canonical(value: str) -> str:
    text = value.strip().lower()
    text = re.sub(r'\(([^()]*)\)', lambda m: '' if m.group(1).strip() in EFFORT_LABELS else m.group(0), text)
    text = re.sub(r'[^a-z0-9]+', '', text)
    text = re.sub(r'20\d{6}$', '', text)
    return ALIASES.get(text, text)


def display_name(value: str) -> str:
    return re.sub(r'\s*\((?:' + '|'.join(re.escape(x) for x in EFFORT_LABELS) + r')\)\s*$', '', value, flags=re.I).strip()


def download(url: str, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={'User-Agent': 'ds-dot-arena-builder/1'})
    with urllib.request.urlopen(request, timeout=60) as response, path.open('wb') as output:
        output.write(response.read())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--revision', default=DEFAULT_REVISION)
    parser.add_argument('--last-modified', default=DEFAULT_LAST_MODIFIED)
    parser.add_argument('--base-url', default='https://huggingface.co')
    parser.add_argument('--source-dir', type=Path)
    parser.add_argument('--output', type=Path, default=Path('src/model-arena.json'))
    args = parser.parse_args()

    revision = args.revision
    last_modified = args.last_modified
    if revision == 'latest':
        metadata = json.loads(download_json(f'{args.base_url}/api/datasets/{DATASET}'))
        revision = metadata['sha']
        last_modified = metadata['lastModified']
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('revision must be "latest" or a full 40-character dataset commit')

    source_dir = args.source_dir or Path('.scratch') / 'arena-source' / revision
    source_dir.mkdir(parents=True, exist_ok=True)
    file_hashes: dict[str, str] = {}
    for config in ARENAS:
        path = source_dir / f'{config}.parquet'
        if not path.exists():
            download(f'{args.base_url}/datasets/{DATASET}/resolve/{revision}/{config}/latest-00000-of-00001.parquet', path)
        file_hashes[f'{config}/latest-00000-of-00001.parquet'] = hashlib.sha256(path.read_bytes()).hexdigest()

    con = duckdb.connect()
    models: dict[str, dict] = {}
    board_dates: dict[str, str] = {}
    for config, arena in ARENAS.items():
        path = source_dir / f'{config}.parquet'
        columns = con.execute('describe select * from read_parquet(?)', [str(path)]).fetchdf()['column_name'].tolist()
        votes_column = 'session_count' if 'session_count' in columns else 'vote_count'
        for category in sorted(USED_CATEGORIES[arena]):
            exists = con.execute('select count(*) from read_parquet(?) where category = ?', [str(path), category]).fetchone()[0]
            if not exists:
                continue
            publish_date = con.execute('select max(leaderboard_publish_date) from read_parquet(?) where category = ?', [str(path), category]).fetchone()[0]
            date_text = publish_date.isoformat() if hasattr(publish_date, 'isoformat') else str(publish_date)
            board_dates[f'{arena}/{category}'] = date_text
            rows = con.execute(f'''
                select model_name, organization, license, rank, {votes_column} as votes
                from read_parquet(?)
                where category = ? and leaderboard_publish_date = ?
                order by rank, model_name
            ''', [str(path), category, publish_date]).fetchdf().to_dict('records')
            rank_count = len(rows)
            best: dict[str, dict] = {}
            for row in rows:
                model_id = canonical(row['model_name'])
                if not model_id:
                    continue
                evidence = {
                    'arena': arena,
                    'category': category,
                    'date': date_text,
                    'modelName': row['model_name'],
                    'rank': int(row['rank']),
                    'rankCount': rank_count,
                    'votes': int(row['votes'] or 0),
                }
                previous = best.get(model_id)
                if previous is None or (evidence['rank'], -evidence['votes']) < (previous['rank'], -previous['votes']):
                    best[model_id] = evidence
                if model_id not in models:
                    models[model_id] = {
                        'id': model_id,
                        'name': display_name(row['model_name']),
                        'organization': row['organization'],
                        'license': row['license'],
                        'evidence': [],
                    }
            retained = sorted(best.values(), key=lambda item: (item['rank'], -item['votes'], item['modelName']))[:TOP_PER_BOARD]
            for evidence in retained:
                models[canonical(evidence['modelName'])]['evidence'].append(evidence)

    document = {
        'schemaVersion': 1,
        'source': {
            'dataset': DATASET,
            'revision': revision,
            'lastModified': last_modified,
            'license': 'CC BY 4.0',
            'url': f'https://huggingface.co/datasets/{DATASET}/tree/{revision}',
            'files': file_hashes,
        },
        'boards': board_dates,
        'models': sorted((model for model in models.values() if model['evidence']), key=lambda model: model['id']),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(document, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    print(f'Wrote {args.output}: {len(document["models"])} base models, {len(board_dates)} boards, revision {revision}')


def download_json(url: str) -> str:
    request = urllib.request.Request(url, headers={'User-Agent': 'ds-dot-arena-builder/1'})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read().decode('utf-8')


if __name__ == '__main__':
    main()
