# Innie Memory MCP Server

Semantic search and journaling for the Innie agent.

## Setup

```bash
npm install
npm run build
```

## Configuration

Set via environment variables or opencode.json:

- `INNIE_STATE_PATH` – Path to state/ directory (default: `./state`)
- `INNIE_LOGS_PATH` – Path to logs/ directory (default: `./logs`)

## Tools

| Tool | Description |
|------|-------------|
| `log_journal` | Write a journal entry |
| `get_recent_journal` | Get recent journal entries |
| `search_memory` | Semantic search over all content |
| `save_conversation_summary` | Save session summary |
| `get_recent_summaries` | Get past summaries |
| `rebuild_memory_index` | Rebuild search index |
| `get_memory_index_stats` | Check index stats |

## Architecture

- **embeddings.ts** – Local embeddings using Transformers.js (all-MiniLM-L6-v2)
- **indexer.ts** – Vectra-based vector search over state files
- **journal.ts** – JSONL-based journaling with conversation summaries
- **index.ts** – MCP server exposing tools

Index is stored in `state/.memory-index/` and auto-created on first use.
