# Innie

A stateful coding agent built on [OpenCode](https://opencode.ai). Maintains memory across sessions via git-tracked state files.

## Quick Start

```bash
# Clone both repos
git clone https://github.com/ascorbic/innie.git
git clone https://github.com/ascorbic/innie-memory.git  # Private repo

# Build the memory server
cd innie
pnpm install
pnpm build
```

Then open this repo in OpenCode. The agent loads `AGENTS.md` as its identity.

## Using in Other Repos

The Innie can work in any repository while maintaining its memory. Add this to your project's `opencode.json`:

```json
{
  "mcp": {
    "memory": {
      "type": "local",
      "command": ["npx", "/path/to/innie/packages/memory"],
      "environment": {
        "MEMORY_DIR": "/path/to/innie-memory"
      }
    }
  }
}
```

For global identity (optional), create `~/.config/opencode/AGENTS.md`:

```markdown
# Identity

You are Innie, a stateful coding agent. Your memory is managed via the `memory` MCP server.

Use your memory tools to:
- Journal important observations with `log_journal`
- Search past context with `search_memory`
- Save session summaries with `save_conversation_summary`

Defer to project-level AGENTS.md for coding conventions.
```

## Repository Structure

| Repo | Purpose | Visibility |
|------|---------|------------|
| `innie` | Code, skills, plugins, MCP server | Public |
| `innie-memory` | State files, journal, summaries | Private |

The memory lives in a separate private repo so:
- State history is git-tracked (rollback, audit trail)
- Sensitive context stays private
- Code can be shared without exposing memory

## Architecture

Based on [Strix](https://timkellogg.me/blog/2025/12/15/strix) and [Acme](https://github.com/ascorbic/acme) – filesystem-based memory beats specialized memory frameworks.

```
innie/                          # This repo (public)
├── AGENTS.md                   # Agent identity and instructions
├── opencode.json               # OpenCode configuration
├── packages/
│   └── memory/                 # MCP server for journaling + semantic search
├── plugins/
│   └── hooks/                  # OpenCode hooks for memory integration
└── .opencode/
    └── skill/                  # Agent skills

innie-memory/                   # Separate repo (private)
├── state/                      # Git-tracked working memory
│   ├── today.md                # Daily focus
│   ├── inbox.md                # Quick capture
│   ├── commitments.md          # Active work
│   ├── ambient-tasks.md        # Quiet-time tasks
│   ├── projects/               # Project context
│   ├── people/                 # People context
│   └── meetings/               # Meeting notes
├── logs/
│   ├── journal.jsonl           # Timestamped observations
│   └── summaries/              # Conversation summaries
└── index/                      # Semantic search index (auto-generated)
```

## Memory Layers

1. **Immediate context** – State files loaded each invocation (via `instructions` in opencode.json)
2. **Session memory** – OpenCode's built-in conversation history
3. **Persistent memory** – Journal and summaries via MCP (`@innie-ai/memory`)
4. **Retrieval** – Semantic search over history (local embeddings via Transformers.js)

## Hooks

The hooks plugin (`plugins/hooks/`) provides automatic memory integration:

- **`file.edited`** – Auto-commits state changes to git (debounced)
- **`experimental.session.compacting`** – Injects summary instruction during context compaction

## Skills

| Skill | Purpose |
|-------|---------|
| `end-of-day` | Daily close-out workflow |
| `weekly-reflection` | Pattern recognition and hygiene |
| `memory-maintenance` | Prune state files within size limits |
| `calendar-prep` | Prepare for upcoming meetings |

## Packages

- **`@innie-ai/memory`** – MCP server for journaling and semantic search

## Environment Variables

The memory MCP server uses:

| Variable | Purpose | Default |
|----------|---------|---------|
| `MEMORY_DIR` | Root directory for state and logs | Current working directory |

## References

- [OpenCode](https://opencode.ai) – The AI coding environment this is built for
- [Strix](https://timkellogg.me/blog/2025/12/15/strix) – Original stateful agent architecture
- [Acme](https://github.com/ascorbic/acme) – Claude Code-based agent (this project's predecessor)
