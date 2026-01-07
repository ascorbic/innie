---
name: memory-maintenance
description: Prune and consolidate state files to stay within size limits and maintain quality
---

# Memory Maintenance

Run this when state files are getting bloated or context feels cluttered. Can be triggered manually or as an ambient task.

## Size Limits

These are the target limits for state files:

| File | Target | Hard limit |
|------|--------|------------|
| today.md | ~30 lines | 50 lines |
| inbox.md | ~20 lines | 30 lines |
| commitments.md | ~40 lines | 60 lines |
| ambient-tasks.md | ~30 lines | 40 lines |

## Workflow

### 1. Check file sizes

Read each state file and count lines. Flag any over the target limit.

### 2. Prune today.md

- Remove completed items older than today
- Consolidate verbose notes into concise summaries
- Move reference information to project files

### 3. Process inbox.md

- Archive or action items older than 3 days
- Consolidate related items
- Delete anything that's no longer relevant

### 4. Clean commitments.md

- Archive completed commitments (move to a `state/archive/` file if needed)
- Merge related commitments
- Remove commitments that have been inactive for 2+ weeks without explicit decision to keep

### 5. Tidy ambient-tasks.md

- Move completed tasks to bottom "Completed" section
- Delete completed tasks older than 1 week
- Remove tasks that are no longer relevant

### 6. Check for duplication

Look for information duplicated across files:

- Same commitment in both today.md and commitments.md
- Project details scattered across multiple files
- Establish single source of truth

### 7. Verify project/people files

For files in `state/projects/` and `state/people/`:

- Remove any that are stale (not referenced in 2+ weeks)
- Consolidate if multiple files cover the same topic
- Ensure each has a clear purpose

### 8. Commit

Stage and commit with message: "Memory maintenance: pruned state files"

## Output

Report:

**Files processed:**
- today.md: X lines -> Y lines
- inbox.md: X lines -> Y lines
- [etc.]

**Items archived/removed:**
- [List of significant removals]

**Issues found:**
- [Any duplication or staleness concerns]
