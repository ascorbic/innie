# @innie-ai/scheduler

Scheduler daemon for Innie. Watches `schedule.json` and triggers `opencode` when events are due.

## How It Works

1. The **memory MCP** provides tools to add/remove/list reminders
2. These tools read/write `schedule.json` in `MEMORY_DIR`
3. The **scheduler daemon** watches this file and schedules jobs
4. When a job fires, it spawns `opencode` with the reminder payload

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_DIR` | `~/.innie` | Path to memory directory containing `schedule.json` |
| `OPENCODE_PATH` | `opencode` | Path to opencode binary |
| `OPENCODE_PROJECT` | `cwd` | Project directory for opencode |

## Installation

```bash
# Build the package
pnpm --filter @innie-ai/scheduler build

# Copy launchd plist (edit paths first!)
cp com.innie.scheduler.plist ~/Library/LaunchAgents/

# Load the daemon
launchctl load ~/Library/LaunchAgents/com.innie.scheduler.plist
```

## Managing the Daemon

```bash
# Start
launchctl start com.innie.scheduler

# Stop
launchctl stop com.innie.scheduler

# Unload (disable)
launchctl unload ~/Library/LaunchAgents/com.innie.scheduler.plist

# Check status
launchctl list | grep innie

# View logs
tail -f ~/Repos/innie-memory/logs/scheduler.log
```

## Schedule Format

The `schedule.json` file contains:

```json
{
  "reminders": [
    {
      "id": "daily-standup",
      "type": "cron",
      "schedule": "0 9 * * 1-5",
      "description": "Daily standup reminder",
      "payload": "Check calendar for today's standup time and remind me",
      "createdAt": "2026-01-07T08:00:00.000Z",
      "lastRun": "2026-01-07T09:00:00.000Z"
    },
    {
      "id": "dentist-reminder",
      "type": "once",
      "schedule": "2026-01-15T09:00:00.000Z",
      "description": "Dentist appointment",
      "payload": "Remind me about the dentist appointment at 10am",
      "createdAt": "2026-01-07T08:00:00.000Z"
    }
  ],
  "version": 2
}
```

## Cron Examples

| Expression | Meaning |
|------------|---------|
| `0 9 * * *` | 9am every day |
| `0 9 * * 1-5` | 9am weekdays |
| `0 */2 * * *` | Every 2 hours |
| `30 17 * * 5` | 5:30pm on Fridays |
| `0 8 1 * *` | 8am on the 1st of each month |
