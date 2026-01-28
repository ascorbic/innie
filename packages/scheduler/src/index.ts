#!/usr/bin/env node
/**
 * Scheduler Daemon for Innie
 *
 * Watches reminders/ directory and triggers opencode when events are due.
 * Each reminder is stored as a separate file to prevent contention.
 * Designed to be run as a persistent daemon via launchd.
 *
 * Environment variables:
 * - MEMORY_DIR: Path to memory directory (default: ~/.innie)
 * - OPENCODE_HOST: OpenCode server host (default: 127.0.0.1)
 * - OPENCODE_PORT: OpenCode server port (default: 4097)
 * - OPENCODE_SERVER_PASSWORD: Password for HTTP Basic Auth (required)
 * - OPENCODE_SERVER_USERNAME: Username for HTTP Basic Auth (default: opencode)

 */

import { watch, existsSync, readdirSync } from "node:fs";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import path from "node:path";
import schedule from "node-schedule";

const MEMORY_DIR =
  process.env.MEMORY_DIR || path.join(process.env.HOME || "", ".innie");
const REMINDERS_DIR = path.join(MEMORY_DIR, "reminders");
const OPENCODE_HOST = process.env.OPENCODE_HOST || "127.0.0.1";
const OPENCODE_PORT = process.env.OPENCODE_PORT || "4097";
const OPENCODE_URL = `http://${OPENCODE_HOST}:${OPENCODE_PORT}`;
const OPENCODE_USERNAME = process.env.OPENCODE_SERVER_USERNAME || "opencode";
const OPENCODE_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD || "";

/**
 * Get Authorization header for Basic Auth
 */
function getAuthHeader(): Record<string, string> {
  if (!OPENCODE_PASSWORD) {
    return {};
  }
  const credentials = Buffer.from(
    `${OPENCODE_USERNAME}:${OPENCODE_PASSWORD}`,
  ).toString("base64");
  return { Authorization: `Basic ${credentials}` };
}

interface ScheduledReminder {
  id: string;
  type: "cron" | "once";
  schedule: string;
  description: string;
  payload: string;
  createdAt: string;
  lastRun?: string;
  model?: string;
}

// Active jobs keyed by reminder ID
const activeJobs = new Map<string, schedule.Job>();

// Track file mtimes to detect changes
const fileMtimes = new Map<string, number>();

/**
 * Log with ISO timestamp
 */
function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function logError(message: string, error?: unknown): void {
  console.error(`[${new Date().toISOString()}] ${message}`, error ?? "");
}

/**
 * Get reminder file path
 */
function getReminderPath(id: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(REMINDERS_DIR, `${safeId}.json`);
}

/**
 * Load a single reminder from file
 */
async function loadReminder(
  filePath: string,
): Promise<ScheduledReminder | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content) as ScheduledReminder;
  } catch (error) {
    logError(`[Scheduler] Failed to load reminder ${filePath}:`, error);
    return null;
  }
}

/**
 * Load all reminders from directory
 */
async function loadAllReminders(): Promise<ScheduledReminder[]> {
  if (!existsSync(REMINDERS_DIR)) {
    return [];
  }

  const reminders: ScheduledReminder[] = [];
  const files = readdirSync(REMINDERS_DIR);

  for (const file of files) {
    if (!file.endsWith(".json") || file.endsWith(".tmp")) continue;

    const filePath = path.join(REMINDERS_DIR, file);
    const reminder = await loadReminder(filePath);
    if (reminder) {
      reminders.push(reminder);
    }
  }

  return reminders;
}

/**
 * Mark a reminder as run (update lastRun timestamp)
 */
async function markReminderRun(id: string): Promise<void> {
  const filePath = getReminderPath(id);
  const reminder = await loadReminder(filePath);
  if (reminder) {
    reminder.lastRun = new Date().toISOString();
    await writeFile(filePath, JSON.stringify(reminder, null, 2));
  }
}

/**
 * Remove a one-shot reminder after it fires
 */
async function removeOnceReminder(id: string): Promise<void> {
  const filePath = getReminderPath(id);
  try {
    await unlink(filePath);
    log(`[Scheduler] Removed one-shot reminder: ${id}`);
  } catch {
    // File might already be gone
  }
}

/**
 * Check if OpenCode server is running
 */
async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${OPENCODE_URL}/global/health`, {
      headers: getAuthHeader(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Create a new session for a scheduled task
 */
async function createSession(title: string): Promise<string> {
  const createRes = await fetch(`${OPENCODE_URL}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeader() },
    body: JSON.stringify({ title }),
  });

  if (!createRes.ok) {
    throw new Error(`Failed to create session: ${createRes.status}`);
  }

  const newSession = (await createRes.json()) as { id: string };
  return newSession.id;
}

/**
 * Trigger opencode with a payload via HTTP API
 */
async function triggerOpencode(reminder: ScheduledReminder): Promise<void> {
  log(`[Scheduler] Triggering: ${reminder.description}`);

  // Check if server is running
  if (!(await isServerRunning())) {
    log(`[Scheduler] OpenCode server not running, skipping trigger`);
    return;
  }

  const now = new Date().toLocaleString("en-GB", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const payload = `[Scheduled reminder: ${reminder.description}]\nCurrent time: ${now}\n\n${reminder.payload}`;

  try {
    const sessionId = await createSession(reminder.description);
    log(`[Scheduler] Created session ${sessionId}`);

    // Send message asynchronously (fire and forget)
    const body: Record<string, unknown> = {
      parts: [{ type: "text", text: payload }],
    };
    if (reminder.model) {
      // Model format: "provider/model-id" -> { providerID, modelID }
      const [providerID, modelID] = reminder.model.split("/");
      if (providerID && modelID) {
        body.model = { providerID, modelID };
      }
    }

    const res = await fetch(
      `${OPENCODE_URL}/session/${sessionId}/prompt_async`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeader() },
        body: JSON.stringify(body),
      },
    );

    if (res.ok) {
      log(`[Scheduler] Triggered: ${reminder.description}`);
      await markReminderRun(reminder.id);

      // Remove one-shot reminders after they fire
      if (reminder.type === "once") {
        await removeOnceReminder(reminder.id);
        activeJobs.get(reminder.id)?.cancel();
        activeJobs.delete(reminder.id);
      }
    } else {
      logError(`[Scheduler] Failed to send: ${res.status} ${res.statusText}`);
    }
  } catch (error) {
    logError(`[Scheduler] Error triggering opencode:`, error);
  }
}

/**
 * Schedule a reminder
 */
function scheduleReminder(reminder: ScheduledReminder): void {
  // Cancel existing job with same ID
  activeJobs.get(reminder.id)?.cancel();

  let job: schedule.Job;

  if (reminder.type === "cron") {
    // Cron-based recurring reminder
    job = schedule.scheduleJob(reminder.id, reminder.schedule, () => {
      triggerOpencode(reminder).catch(console.error);
    });
  } else {
    // One-shot reminder
    const date = new Date(reminder.schedule);
    if (date <= new Date()) {
      log(`[Scheduler] Skipping past reminder: ${reminder.description}`);
      return;
    }
    job = schedule.scheduleJob(reminder.id, date, () => {
      triggerOpencode(reminder).catch(console.error);
    });
  }

  if (job) {
    activeJobs.set(reminder.id, job);
    const nextRun = job.nextInvocation();
    log(
      `[Scheduler] Scheduled: ${reminder.description} (next: ${nextRun?.toISOString() || "N/A"})`,
    );
  } else {
    logError(`[Scheduler] Failed to schedule: ${reminder.description}`);
  }
}

/**
 * Sync a single reminder file
 */
async function syncReminderFile(filePath: string): Promise<void> {
  const reminder = await loadReminder(filePath);
  if (reminder) {
    scheduleReminder(reminder);
  }
}

/**
 * Sync all reminders from directory
 */
async function syncAllReminders(): Promise<void> {
  const reminders = await loadAllReminders();
  const currentIds = new Set(reminders.map((r) => r.id));

  // Cancel jobs for removed reminders
  for (const [id, job] of activeJobs) {
    if (!currentIds.has(id)) {
      log(`[Scheduler] Removing: ${id}`);
      job.cancel();
      activeJobs.delete(id);
    }
  }

  // Schedule all reminders
  for (const reminder of reminders) {
    scheduleReminder(reminder);
  }
}

/**
 * Watch reminders directory for changes
 */
function watchRemindersDir(): void {
  if (!existsSync(REMINDERS_DIR)) {
    log(`[Scheduler] Reminders directory not found, creating...`);
    mkdir(REMINDERS_DIR, { recursive: true }).catch(console.error);
  }

  const watcher = watch(REMINDERS_DIR, async (eventType, filename) => {
    if (!filename || !filename.endsWith(".json") || filename.endsWith(".tmp")) {
      return;
    }

    // Debounce rapid changes
    await new Promise((resolve) => setTimeout(resolve, 100));

    const filePath = path.join(REMINDERS_DIR, filename);

    if (existsSync(filePath)) {
      // File added or modified
      log(`[Scheduler] Reminder changed: ${filename}`);
      await syncReminderFile(filePath);
    } else {
      // File removed
      const id = filename.replace(".json", "");
      if (activeJobs.has(id)) {
        log(`[Scheduler] Reminder removed: ${id}`);
        activeJobs.get(id)?.cancel();
        activeJobs.delete(id);
      }
    }
  });

  watcher.on("error", (error) => {
    logError("[Scheduler] Watch error:", error);
  });

  log(`[Scheduler] Watching: ${REMINDERS_DIR}`);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  log("[Scheduler] Starting...");
  log(`[Scheduler] MEMORY_DIR: ${MEMORY_DIR}`);
  log(`[Scheduler] REMINDERS_DIR: ${REMINDERS_DIR}`);
  log(`[Scheduler] OPENCODE_URL: ${OPENCODE_URL}`);
  if (OPENCODE_PASSWORD) {
    log(`[Scheduler] Auth: Basic auth enabled (user: ${OPENCODE_USERNAME})`);
  } else {
    log(`[Scheduler] Auth: No password set - set OPENCODE_SERVER_PASSWORD`);
  }

  // Ensure reminders directory exists
  if (!existsSync(REMINDERS_DIR)) {
    await mkdir(REMINDERS_DIR, { recursive: true });
  }

  // Initial sync
  await syncAllReminders();

  // Watch for changes
  watchRemindersDir();

  // Also poll every minute in case file watch misses changes
  setInterval(() => {
    syncAllReminders().catch(console.error);
  }, 60 * 1000);

  log("[Scheduler] Running. Press Ctrl+C to stop.");

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    log("[Scheduler] Shutting down...");
    for (const job of activeJobs.values()) {
      job.cancel();
    }
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    log("[Scheduler] Received SIGTERM, shutting down...");
    for (const job of activeJobs.values()) {
      job.cancel();
    }
    process.exit(0);
  });
}

main().catch((error) => {
  logError("[Scheduler] Fatal error:", error);
  process.exit(1);
});
