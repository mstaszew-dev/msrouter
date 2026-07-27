# Director RAG

Director-owned SQLite RAG over the campaign's `events.jsonl` (apps collection)
and the campaign runbooks (docs collection). Mirrors OpenClaw's `rag/`
technique (`minishlab/potion-base-8M` static embeddings, cosine search) but
uses a separate `index.db` so there is no SQLite concurrency with the worker.

## Rebuild

```
.venv/bin/python index_builder.py            # build index.db
.venv/bin/python index_builder.py --check    # count rows only
```

## Run (line protocol, used by the Director's TypeScript RagClient)

```
.venv/bin/python rag_server.py --line-protocol \
  --db index.db \
  --campaign /Users/mst/Downloads/job-search/job-apply
```

Reads one JSON request per line:
`{"id":1,"tool":"rag_search_apps","args":{"query":"...","k":5}}`

Writes one JSON response per line:
`{"id":1,"result":[{"score":0.92,"text":"..."}]}`

The default mode (no `--line-protocol`) is the original MCP stdio server,
unchanged from OpenClaw; the Director only uses `--line-protocol`.

## venv setup

```
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Why a separate index.db

OpenClaw's worker rebuilds its own `rag/index.db` periodically. If the Director
shared that db, a rebuild during a Director query would race. The Director
keeps its own copy (rebuilt on a separate schedule via the same builder) so
the two processes never touch the same SQLite file.
