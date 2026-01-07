# Innie

A stateful coding agent for [OpenCode](https://opencode.ai). Maintains memory across sessions via git-tracked state files and can work autonomously on scheduled tasks.

## Quick Start

```bash
git clone https://github.com/ascorbic/innie.git
cd innie
pnpm install && pnpm build
```

Open the repo in OpenCode and run `/setup` for the full setup guide.

## Structure

```
innie/                         # This repo (public)
├── AGENTS.md                  # Agent identity
├── packages/
│   ├── memory/                # MCP server (journaling, semantic search)
│   └── scheduler/             # Daemon for scheduled tasks
├── plugins/hooks/             # Auto-commit state changes
└── .opencode/skill/           # Skills

innie-memory/                  # Separate repo (private)
├── state/                     # Git-tracked working memory
├── logs/journal.jsonl         # Timestamped observations
├── schedule.json              # Reminders and cron tasks
└── index/                     # Semantic search index
```

## Skills

| Skill                | Purpose                    |
| -------------------- | -------------------------- |
| `setup`              | Full setup guide           |
| `end-of-day`         | Daily review workflow      |
| `calendar-prep`      | Prep for upcoming meetings |
| `memory-maintenance` | Prune state files          |
| `weekly-reflection`  | Pattern recognition        |
| `alerts`             | macOS notifications        |
| `calendar`           | Read Calendar.app events   |
| `pr`                 | Pull request workflow      |
