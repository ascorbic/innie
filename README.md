# Innie

A stateful coding agent built on [OpenCode](https://opencode.ai). Maintains memory across sessions via git-tracked state files.

## Setup

```bash
pnpm install
pnpm build
```

Then open this repo in OpenCode. The agent will load `AGENTS.md` as its instructions.

## Architecture

Based on [Strix](https://timkellogg.me/blog/2025/12/15/strix) and [Acme](https://github.com/ascorbic/acme) – the core insight is that filesystem-based memory beats specialized memory frameworks.

```
innie/
├── AGENTS.md               # Agent identity and instructions
├── opencode.json           # OpenCode configuration
├── packages/
│   └── memory/             # MCP server for journaling + semantic search
├── plugins/
│   └── hooks/              # OpenCode hooks for memory integration
├── .opencode/
│   └── skill/              # Agent skills (end-of-day, calendar-prep, etc.)
└── state/                  # Git-tracked working memory
    ├── today.md            # Daily focus
    ├── inbox.md            # Quick capture
    ├── commitments.md      # Active work
    ├── ambient-tasks.md    # Quiet-time tasks
    ├── projects/           # Project context
    ├── people/             # People context
    └── meetings/           # Meeting briefings and notes
```

## Memory Layers

1. **Immediate context** – State files loaded each invocation (via `instructions` in opencode.json)
2. **Session memory** – OpenCode's built-in conversation history
3. **Persistent memory** – Journal and summaries via MCP (`@innie/memory`)
4. **Retrieval** – Semantic search over history (local embeddings via Transformers.js)

## Hooks

The `@innie/hooks` plugin provides automatic memory integration:

- **`file.edited`** – Indexes state files when they change (keeps search current)
- **`experimental.session.compacting`** – Preserves critical state during context compaction

## Skills

| Skill | Purpose |
|-------|---------|
| `end-of-day` | Daily close-out workflow |
| `weekly-reflection` | Pattern recognition and hygiene |
| `memory-maintenance` | Prune state files within size limits |
| `calendar-prep` | Prepare for upcoming meetings |

## Packages

- **`@innie/memory`** – MCP server for journaling and semantic search
- **`@innie/hooks`** – OpenCode plugin for memory hooks
