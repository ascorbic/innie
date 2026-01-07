---
status: active
priority: medium
stakeholders: [matt, opencode-maintainers]
due_date: null
---

# OpenCode Compaction Hook

## Background

OpenCode has a `experimental.session.compacting` hook that fires *before* compaction, but no hook that fires *after*. This limits what agents can do with compaction events.

Currently we work around this by injecting an instruction into the compacted context asking the model to log a summary. This works but feels hacky – it relies on the model following the instruction rather than guaranteed execution.

## Proposal

Add a `session.compacted` hook that fires after compaction completes, giving plugins a chance to:

1. **Log summaries** – save a journal entry capturing what was compacted
2. **Update state** – sync state files based on what's in the new context
3. **Trigger notifications** – alert external systems about the compaction event
4. **Run memory maintenance** – prune old data, rebuild indexes, etc.

## Implementation Notes

Questions to investigate:
- [ ] Where does compaction happen in the OpenCode codebase?
- [ ] What context is available after compaction completes?
- [ ] How do existing hooks get the output they need?
- [ ] Should the hook receive the pre-compaction context, post-compaction context, or both?

Likely signature:
```typescript
hooks.on('session.compacted', async (ctx) => {
  // ctx.previousLength - tokens before compaction
  // ctx.newLength - tokens after compaction
  // ctx.summary - what the model generated as summary (if available)
  await logJournal('compaction', `Compacted ${ctx.previousLength} → ${ctx.newLength} tokens`)
})
```

## Prior Art

Check how similar projects handle this:
- Claude Code (Anthropic's agent) – how does it handle context overflow?
- Cursor/Aider – do they have compaction hooks?
- The hook system in my own codebase (Acme)

## Outcome

A PR to opencode-ai/opencode adding the `session.compacted` hook. Should include:
- Hook implementation
- Documentation update
- Example usage in a test plugin
