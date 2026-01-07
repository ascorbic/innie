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

| Category             | Prep needed                                                            |
| -------------------- | ---------------------------------------------------------------------- |
| **1:1 internal**     | Check for context in people file, recent interactions                  |
| **1:1 external**     | Research attendee, create/update people file, prepare briefing         |
| **Team meeting**     | Review agenda if available, check for action items from last time      |
| **External meeting** | Research company/attendees, prepare briefing, check for shared context |
| **Interview**        | Research candidate thoroughly, prepare questions                       |
| **Presentation**     | Ensure materials ready, rehearsal notes                                |

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

### 5. Create meeting folders (when needed)

Only create a meeting folder when the meeting needs artifacts (briefings, prep docs, notes). Don't create folders for routine meetings.

**Structure:** `state/meetings/[date]-[meeting-slug]/`

Create a folder when:

- External meeting requiring research
- Interview
- Important presentation
- Complex meeting needing prep docs
- Any meeting where you'll want to capture notes

**Don't create a folder for:**

- Regular standups
- Quick syncs
- Routine 1:1s (unless there's something specific to prep)

**Folder contents (as needed):**

```
state/meetings/2026-01-07-acme-intro/
├── briefing.md      # Pre-meeting research and talking points
├── prep.md          # Specific preparation tasks or documents
└── notes.md         # Meeting notes (created during/after)
```

**Briefing template** (`briefing.md`):

```markdown
---
date: 2026-01-07T14:00:00
attendees:
  - alice@example.com
  - bob@example.com
type: external
status: upcoming
---

# [Meeting name]

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
```

The frontmatter enables queries like "find all upcoming external meetings" or "meetings with Alice in the last month".

### 6. Schedule meeting reminders

For each meeting today that involves a call (has a Zoom/Meet/Teams link, or location indicates video call):

1. First check existing reminders with `list_reminders`
2. Skip if a reminder for this meeting already exists
3. Schedule a one-shot reminder 1 minute before the meeting start time

```bash
# Use schedule_once with meeting ID or slug
schedule_once(
  id: "meeting-[event-slug]",
  datetime: "[meeting-start-minus-1-min-ISO]",
  description: "Meeting reminder: [meeting title]",
  payload: "Show a modal alert: '[meeting title]' starts in 1 minute. [Include Zoom/Meet link if available]"
)
```

Indicators a meeting has a call:

- Location contains "zoom", "meet.google", "teams.microsoft"
- Description contains video conferencing links
- Event title mentions "call" or "sync"

Skip reminders for:

- All-day events
- In-person meetings (office room locations)
- Meetings that already have a reminder scheduled

### 7. Update today.md

Add calendar-related items to today's priorities:

- Prep tasks with deadlines
- Reminder of key meetings
- Any briefings to review

## People file template

When creating a new person file at `state/people/[name].md`:

```markdown
---
email: alice@example.com
company: Acme Corp
role: Product Manager
relationship: external
last_contact: 2026-01-07
---

# Alice Smith

## Context

[How we know them, relationship context]

## Notes

[Key things to remember - communication style, interests, previous discussions]

## Interactions

- 2026-01-07: [Brief note on interaction]
```

The frontmatter makes the file queryable (find external contacts, people not contacted recently), while the body stays human-readable.

## Output

After completing the workflow, summarize:

- Events requiring attention in the next 24-48 hours
- Prep tasks added to today.md
- New people files created
- Meeting folders created (with paths)
- Meeting reminders scheduled (with times)
- Gaps (events you couldn't fully prep for and why)
