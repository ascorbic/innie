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

For global configuration, create files in `~/.config/opencode/`:

**`~/.config/opencode/opencode.json`** – MCP servers and settings for all repos:

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

**`~/.config/opencode/skill/`** – Copy skills here to make them available globally:

```bash
mkdir -p ~/.config/opencode/skill
cp /path/to/innie/.opencode/skill/*.md ~/.config/opencode/skill/
```

**`~/.config/opencode/AGENTS.md`** – Identity instructions for all repos:

```markdown
# Identity

You are Innie, a stateful coding agent. Your memory is managed via the `memory` MCP server.

Use your memory tools to:
- Journal important observations with `log_journal`
- Search past context with `search_memory`
- Save session summaries with `save_conversation_summary`

Defer to project-level AGENTS.md for coding conventions.
```

Global config merges with project-level config. Project settings take precedence.

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
│   ├── memory/                 # MCP server for journaling + semantic search
│   ├── calendar/               # MCP server for Calendar.app via AppleScript
│   └── scheduler/              # Daemon for scheduled triggers
├── plugins/
│   └── hooks/                  # OpenCode hooks for memory integration
└── .opencode/
    └── skill/                  # Agent skills (end-of-day, alerts, etc.)

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
3. **Persistent memory** – Journal and summaries via MCP (`@mk.gg/innie-memory`)
4. **Retrieval** – Semantic search over history (local embeddings via Transformers.js)
5. **Scheduling** – Reminders and ambient triggers via scheduler daemon

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
| `alerts` | Send notifications via AppleScript (banner, modal dialog, text-to-speech) |

## Packages

| Package | Description |
|---------|-------------|
| `@mk.gg/innie-memory` | MCP server for journaling and semantic search (local embeddings via Transformers.js) |
| `@mk.gg/innie-calendar` | MCP server using AppleScript to query Calendar.app |
| `@mk.gg/innie-scheduler` | Daemon for scheduled triggers – watches `schedule.json` and spawns opencode |

## Scheduler Daemon

The scheduler (`@mk.gg/innie-scheduler`) runs as a persistent daemon managed by launchd. It watches `schedule.json` in `MEMORY_DIR` and spawns opencode when events fire.

**Architecture:**

```
┌─────────────────────────────────────────────────────┐
│  Scheduler Daemon (launchd-managed)                 │
│  • node-schedule for cron parsing                   │
│  • Watches MEMORY_DIR/schedule.json                 │
│  • On trigger: spawns `opencode "...payload..."`    │
└─────────────────────────────────────────────────────┘
           ↑ reads
           │
┌──────────────────────────────────────┐
│  schedule.json                       │
│  • Cron reminders                    │
│  • One-shot events                   │
│  • Written by memory MCP tools       │
└──────────────────────────────────────┘
```

**Setup:**

```bash
# Build the scheduler
cd packages/scheduler && pnpm build

# Install the launchd plist
cp gg.mk.innie.scheduler.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/gg.mk.innie.scheduler.plist
```

The memory MCP provides tools to manage the schedule:
- `schedule_reminder` – Recurring cron-based reminder
- `schedule_once` – One-shot event at a specific time
- `list_reminders` – Show all scheduled events
- `remove_reminder` – Delete a scheduled event

## Environment Variables

The memory MCP server uses:

| Variable | Purpose | Default |
|----------|---------|---------|
| `MEMORY_DIR` | Root directory for state and logs | Current working directory |

## References

- [OpenCode](https://opencode.ai) – The AI coding environment this is built for
- [Strix](https://timkellogg.me/blog/2025/12/15/strix) – Original stateful agent architecture
- [Acme](https://github.com/ascorbic/acme) – Claude Code-based agent (this project's predecessor)
