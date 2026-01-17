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
| `MEMORY_DIR` | `~/.innie` | Path to memory directory containing reminders |
| `OPENCODE_HOST` | `127.0.0.1` | OpenCode HTTP server host |
| `OPENCODE_PORT` | `4097` | OpenCode HTTP server port |
| `OPENCODE_SERVER_PASSWORD` | (none) | Password for HTTP Basic Auth |
| `OPENCODE_SERVER_USERNAME` | `opencode` | Username for HTTP Basic Auth |
| `TELEGRAM_BOT_TOKEN` | (none) | Telegram bot token for message integration |
| `TELEGRAM_CHAT_ID` | (none) | Restrict bot to specific chat ID (recommended)

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

## Telegram Integration

The scheduler can receive messages via Telegram and route them to OpenCode sessions.

### Setup

1. Create a bot via [@BotFather](https://t.me/BotFather) and get the token
2. Get your chat ID (send a message to the bot, then check `https://api.telegram.org/bot<TOKEN>/getUpdates`)
3. Set environment variables:
   ```bash
   export TELEGRAM_BOT_TOKEN="123456:ABC-DEF..."
   export TELEGRAM_CHAT_ID="12345678"  # Your chat ID
   ```

### How It Works

1. The daemon long-polls Telegram for new messages (30s timeout)
2. When a message arrives, it checks if the "Telegram" session is busy
3. If busy, it aborts the current task first (interrupt-and-resume)
4. The message is sent to OpenCode via `prompt_async`
5. Innie processes the message and can respond via its own Telegram tools

### Security

Always set `TELEGRAM_CHAT_ID` to restrict the bot to your personal chat. Without this, the bot will respond to messages from any user.
