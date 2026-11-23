# Arena-backed model recommendations

`dot_list_models` defaults to a read-only aggregate recommendation over the models allowed by the human's current task-model rule. Use `mode=raw` for the original eligible catalog and default-model explanation. Recommendations never select a model or mutate a route: Dorothy must pass an explicit `provider/model` to `dot_task action=dispatch`, and a human-named model remains a pin.

## Pinned source

The bundled `src/model-arena.json` is generated from **LMArena's official `lmarena-ai/leaderboard-dataset`**, licensed **CC BY 4.0**. It records the full source revision, per-file SHA-256 hashes, and each board's publication date. Runtime recommendation code performs no network requests.

The current document uses Text (style control), WebDev, Vision (style control), Document (style control), Search (style control), and Agent Capability data. Reasoning-effort variants of one base model collapse to the best-ranked configuration per board, retaining the top 20 configurations per board while preserving the full board size as the percentile denominator. API routes with no conservative identity match stay unranked; no score or alias is invented.

## Aggregate

Each tag maps to weighted boards. A row becomes a percentile inside its own board, so Elo-like values from different arenas are never averaged directly. Percentiles shrink toward neutral (`50`) by `votes / (votes + 1000)`, limiting premature conclusions from low-vote rows. Missing boards contribute neutral evidence and are shown as coverage below 100%. Score ties preserve the host catalog order.

Supported tags: `general`, `coding`, `debugging`, `review`, `frontend`, `writing`, `research`, `analysis`, `planning`, `vision`, `ocr`, `document`, `chinese`, `math`, `instruction`, `multi-turn`.

Examples:

```text
dot_list_models { "tags": "coding,review", "limit": 3 }
dot_list_models { "tags": "vision,ocr" }
dot_list_models { "mode": "raw" }
```

## Refresh

Install DuckDB for the offline builder (pandas is not required), then regenerate from the same or a new full dataset commit:

```sh
python scripts/build-model-arena.py --source-dir .scratch/arena-source
python scripts/build-model-arena.py --revision latest --base-url https://hf-mirror.com
```

`--source-dir` is a cache root. Parquet files are stored per dataset commit under `<source-dir>/<revision>/`, so reusing the same root cannot label an old board as a new revision.

`latest` resolves the current official metadata and records the resulting commit. Use a full 40-character revision for reproducible output. `--last-modified` defaults to the pinned commit's timestamp; a different full revision fetches that commit's timestamp unless you pass `--last-modified`. `--base-url` only changes transport; generated provenance always points to the official Hugging Face dataset. After regeneration, run `pnpm typecheck && pnpm test && pnpm build` and inspect the ranking diff before committing `src/model-arena.json`.
