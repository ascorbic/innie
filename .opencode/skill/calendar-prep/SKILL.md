---
name: calendar-prep
description: Prepare for upcoming calendar events - identify prep needs, research attendees, create briefings
---

# Calendar Prep

Run this daily (morning) or when asked to prepare for upcoming meetings. Ensures you're never caught off-guard in meetings.

## Prerequisites

This skill requires calendar access. If not available yet, note the limitation and skip calendar-dependent steps.

## Workflow

### 1. Fetch upcoming events

Get calendar events for the next 24-48 hours. Focus on:

- Events where you're specifically invited (not just team-wide)
- Team events you've RSVP'd "yes" to
- Any event with external attendees

Skip:
- Declined events
- All-day events (unless they're deadlines)
- Recurring standups (unless there's a specific agenda)

### 2. Categorize each event

For each relevant event, determine:

| Category | Prep needed |
|----------|-------------|
| **1:1 internal** | Check for context in people file, recent interactions |
| **1:1 external** | Research attendee, create/update people file, prepare briefing |
| **Team meeting** | Review agenda if available, check for action items from last time |
| **External meeting** | Research company/attendees, prepare briefing, check for shared context |
| **Interview** | Research candidate thoroughly, prepare questions |
| **Presentation** | Ensure materials ready, rehearsal notes |

### 3. Research external attendees

For any external person not already in `state/people/`:

1. **Create a people file** at `state/people/[name-slug].md`
2. **Research** (web search if tools available):
   - Current role and company
   - LinkedIn summary
   - Recent public activity (blog posts, talks, tweets)
   - Shared connections or context
   - Previous interactions (search emails, chat history if available)
3. **Note the meeting context**: Why are we meeting? What might they want?

### 4. Identify preparation tasks

For each event, ask:

- Do I need to review any documents beforehand?
- Are there action items I committed to from last meeting?
- Is there context I should refresh (project status, recent decisions)?
- Should I prepare questions or talking points?

Add any prep tasks to `state/today.md` with the meeting time as deadline.

### 5. Create briefings

For significant external meetings, create a briefing in `state/briefings/[date]-[meeting-slug].md`:

```markdown
# Briefing: [Meeting name]
**Date:** [Date and time]
**Attendees:** [List]

## Context
[Why this meeting is happening, what we hope to achieve]

## About [External person/company]
[Key facts from research]

## Talking points
- [Point 1]
- [Point 2]

## Questions to ask
- [Question 1]
- [Question 2]

## Prep checklist
- [ ] [Any prep tasks]
```

### 6. Update today.md

Add calendar-related items to today's priorities:

- Prep tasks with deadlines
- Reminder of key meetings
- Any briefings to review

## People file template

When creating a new person file at `state/people/[name].md`:

```markdown
# [Full Name]

**Role:** [Title at Company]
**Company:** [Company name]
**First contact:** [Date and context]

## Context
[How we know them, relationship context]

## Notes
[Key things to remember - communication style, interests, previous discussions]

## Interactions
- [Date]: [Brief note on interaction]
```

## Output

After completing the workflow, summarize:

- Events requiring attention in the next 24-48 hours
- Prep tasks added to today.md
- New people files created
- Any briefings prepared
- Gaps (events you couldn't fully prep for and why)
