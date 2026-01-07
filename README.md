# Innie

A stateful coding agent for [OpenCode](https://opencode.ai). Maintains memory across sessions via git-tracked state files and can work autonomously on scheduled tasks.

Based on [Strix](https://timkellogg.me/blog/2025/12/15/strix) and [Acme](https://github.com/ascorbic/acme).

## Setup

```bash
git clone https://github.com/ascorbic/innie.git
git clone https://github.com/ascorbic/innie-memory.git  # Your private memory repo

cd innie
pnpm install
pnpm build
```

Then open this repo in OpenCode. The agent identity is in `AGENTS.md`.

## Structure

Two repos work together:

| Repo           | Contents                            | Visibility |
| -------------- | ----------------------------------- | ---------- |
| `innie`        | Code, MCP server, scheduler, skills | Public     |
| `innie-memory` | State files, journal, schedule      | Private    |

```
innie/
├── AGENTS.md              # Agent identity
├── packages/
│   ├── memory/            # MCP server (journaling, semantic search)
│   └── scheduler/         # Daemon for scheduled tasks
├── plugins/hooks/         # Auto-commit state changes
└── .opencode/skill/       # Skills (end-of-day, calendar-prep, etc.)

innie-memory/
├── state/                 # Git-tracked working memory
│   ├── today.md
│   ├── inbox.md
│   ├── commitments.md
│   ├── projects/
│   └── people/
├── logs/journal.jsonl     # Timestamped observations
├── schedule.json          # Reminders and cron tasks
└── index/                 # Semantic search index
```

## Configuration

For global config across all repos, create `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "instructions": [
    "/path/to/innie-memory/state/today.md",
    "/path/to/innie-memory/state/inbox.md",
    "/path/to/innie-memory/state/commitments.md"
  ],
  "mcp": {
    "memory": {
      "type": "local",
      "command": ["npx", "/path/to/innie/packages/memory"],
      "environment": {
        "MEMORY_DIR": "/path/to/innie-memory"
      }
    }
  },
  "permission": {
    "external_directory": {
      "/path/to/innie-memory/**": "allow"
    }
  }
}
```

The `external_directory` permission lets the agent access memory files from any working directory. Without it, scheduled tasks fail.

Copy skills for global access:

```bash
cp -r /path/to/innie/.opencode/skill/* ~/.config/opencode/skill/
```

## Scheduler

The scheduler daemon watches `schedule.json` and triggers OpenCode when tasks are due.

**Install:**

```bash
cd packages/scheduler
pnpm build

# Edit the plist to fix paths, then:
cp gg.mk.innie.scheduler.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/gg.mk.innie.scheduler.plist
```

**Memory tools for scheduling:**

- `schedule_reminder` – Recurring cron task
- `schedule_once` – One-shot at specific time
- `list_reminders` – Show scheduled tasks
- `remove_reminder` – Delete a task

## Memory Tools

| Tool                        | Purpose                         |
| --------------------------- | ------------------------------- |
| `log_journal`               | Record observations             |
| `search_memory`             | Semantic search over everything |
| `save_conversation_summary` | Capture session context         |
| `get_recent_journal`        | Recent journal entries          |
| `get_recent_summaries`      | Recent session summaries        |

## Skills

| Skill                | Purpose                                   |
| -------------------- | ----------------------------------------- |
| `end-of-day`         | Daily review workflow                     |
| `calendar-prep`      | Prep for upcoming meetings                |
| `memory-maintenance` | Prune state files                         |
| `weekly-reflection`  | Pattern recognition                       |
| `alerts`             | macOS notifications (banner, dialog, TTS) |
| `calendar`           | Read Calendar.app events                  |
| `setup`              | First-time setup guide                    |
| `pr`                 | Pull request workflow                     |
