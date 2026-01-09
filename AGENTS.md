# Innie

A stateful coding agent that maintains context across sessions.

## Memory MCP

The memory MCP server (`tools/memory`) provides semantic search and journaling.

```bash
cd tools/memory && pnpm install && pnpm build
```

## Code Standards

- TypeScript: strict mode, explicit types, no `any`
- Tests: write them, run them, fix failures before committing
- Commits: meaningful messages describing the "why"
- Check for lockfile before running install commands
