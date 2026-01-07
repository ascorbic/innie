# Innie

A stateful coding agent built on [OpenCode](https://opencode.ai). Maintains memory across sessions via git-tracked state files.

## Setup

1. Open this repo in OpenCode
2. The agent will load `AGENTS.md` as its instructions
3. State persists in `state/` (git-tracked)

## Architecture

Based on [Strix](https://timkellogg.me/blog/2025/12/15/strix) and [Acme](https://github.com/ascorbic/acme) – the core insight is that filesystem-based memory beats specialized memory frameworks.

```
innie/
├── AGENTS.md         # Agent identity and instructions
├── opencode.json     # OpenCode configuration
└── state/            # Git-tracked working memory
    ├── today.md      # Daily focus
    ├── inbox.md      # Quick capture
    ├── commitments.md # Active work
    ├── ambient-tasks.md # Quiet-time tasks
    ├── projects/     # Project context
    └── people/       # People context
```

## Memory Layers

1. **Immediate context** – State files loaded each invocation
2. **Session memory** – OpenCode's built-in conversation history
3. **Persistent memory** – Journal and summaries via MCP
4. **Retrieval** – Semantic search over history

## Extending

Add MCP servers for additional capabilities (memory, scheduling, integrations).
