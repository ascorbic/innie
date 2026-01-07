#!/usr/bin/env node
/**
 * Scheduler Daemon for Innie
 *
 * Watches schedule.json and triggers opencode when events are due.
 * Designed to be run as a persistent daemon via launchd.
 *
 * Environment variables:
 * - MEMORY_DIR: Path to memory directory (default: ~/.innie)
 * - OPENCODE_HOST: OpenCode server host (default: 127.0.0.1)
 * - OPENCODE_PORT: OpenCode server port (default: 4097)
 */

import { watch, existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import schedule from "node-schedule";

const MEMORY_DIR =
  process.env.MEMORY_DIR || path.join(process.env.HOME || "", ".innie");
const SCHEDULE_FILE = path.join(MEMORY_DIR, "schedule.json");
const OPENCODE_HOST = process.env.OPENCODE_HOST || "127.0.0.1";
const OPENCODE_PORT = process.env.OPENCODE_PORT || "4096";
const OPENCODE_URL = `http://${OPENCODE_HOST}:${OPENCODE_PORT}`;

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

interface ScheduleState {
  reminders: ScheduledReminder[];
  version: number;
}

// Active jobs keyed by reminder ID
const activeJobs = new Map<string, schedule.Job>();

// Current schedule version (for detecting changes)
let currentVersion = 0;

/**
 * Load schedule state from file
 */
async function loadSchedule(): Promise<ScheduleState> {
  try {
    if (!existsSync(SCHEDULE_FILE)) {
      return { reminders: [], version: 0 };
    }
    const content = await readFile(SCHEDULE_FILE, "utf-8");
    return JSON.parse(content) as ScheduleState;
  } catch (error) {
    console.error("[Scheduler] Failed to load schedule:", error);
    return { reminders: [], version: 0 };
  }
}

/**
 * Save schedule state (for updating lastRun)
 */
async function saveSchedule(state: ScheduleState): Promise<void> {
  await writeFile(SCHEDULE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Mark a reminder as run
 */
async function markReminderRun(id: string): Promise<void> {
  const state = await loadSchedule();
  const reminder = state.reminders.find((r) => r.id === id);
  if (reminder) {
    reminder.lastRun = new Date().toISOString();
    state.version++;
    currentVersion = state.version; // Update local version to avoid re-sync
    await saveSchedule(state);
  }
}

/**
 * Remove a one-shot reminder after it fires
 */
async function removeOnceReminder(id: string): Promise<void> {
  const state = await loadSchedule();
  state.reminders = state.reminders.filter((r) => r.id !== id);
  state.version++;
  currentVersion = state.version;
  await saveSchedule(state);
}

/**
 * Check if OpenCode server is running
 */
async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${OPENCODE_URL}/global/health`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Get or create a session for scheduled tasks
 */
async function getOrCreateSession(): Promise<string> {
  // List existing sessions
  const listRes = await fetch(`${OPENCODE_URL}/session`);
  if (!listRes.ok) {
    throw new Error(`Failed to list sessions: ${listRes.status}`);
  }

  const sessions = (await listRes.json()) as Array<{
    id: string;
    title?: string;
  }>;

  // Look for an existing scheduler session
  const schedulerSession = sessions.find((s) => s.title === "Scheduler");
  if (schedulerSession) {
    return schedulerSession.id;
  }

  // Create a new session for scheduled tasks
  const createRes = await fetch(`${OPENCODE_URL}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Scheduler" }),
  });

  if (!createRes.ok) {
    throw new Error(`Failed to create session: ${createRes.status}`);
  }

  const newSession = (await createRes.json()) as { id: string };
  console.log(`[Scheduler] Created new session: ${newSession.id}`);
  return newSession.id;
}

/**
 * Trigger opencode with a payload via HTTP API
 */
async function triggerOpencode(reminder: ScheduledReminder): Promise<void> {
  console.log(`[Scheduler] Triggering: ${reminder.description}`);

  // Check if server is running
  if (!(await isServerRunning())) {
    console.log(`[Scheduler] OpenCode server not running, skipping trigger`);
    return;
  }

  const payload = `[Scheduled reminder: ${reminder.description}]\n\n${reminder.payload}`;

  try {
    const sessionId = await getOrCreateSession();

    // Send message asynchronously (don't wait for response)
    const body: Record<string, unknown> = {
      parts: [{ type: "text", text: payload }],
    };
    if (reminder.model) {
      body.model = reminder.model;
    }
    
    const res = await fetch(
      `${OPENCODE_URL}/session/${sessionId}/prompt_async`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    if (res.ok) {
      console.log(
        `[Scheduler] Sent to session ${sessionId}: ${reminder.description}`,
      );
      await markReminderRun(reminder.id);

      // Remove one-shot reminders after they fire
      if (reminder.type === "once") {
        await removeOnceReminder(reminder.id);
        activeJobs.get(reminder.id)?.cancel();
        activeJobs.delete(reminder.id);
      }
    } else {
      console.error(
        `[Scheduler] Failed to send: ${res.status} ${res.statusText}`,
      );
    }
  } catch (error) {
    console.error(`[Scheduler] Error triggering opencode:`, error);
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
      console.log(
        `[Scheduler] Skipping past reminder: ${reminder.description}`,
      );
      return;
    }
    job = schedule.scheduleJob(reminder.id, date, () => {
      triggerOpencode(reminder).catch(console.error);
    });
  }

  if (job) {
    activeJobs.set(reminder.id, job);
    const nextRun = job.nextInvocation();
    console.log(
      `[Scheduler] Scheduled: ${reminder.description} (next: ${nextRun?.toISOString() || "N/A"})`,
    );
  } else {
    console.error(`[Scheduler] Failed to schedule: ${reminder.description}`);
  }
}

/**
 * Sync jobs with schedule file
 */
async function syncSchedule(): Promise<void> {
  const state = await loadSchedule();

  // Skip if version hasn't changed
  if (state.version === currentVersion) {
    return;
  }

  console.log(
    `[Scheduler] Syncing schedule (version ${currentVersion} -> ${state.version})`,
  );
  currentVersion = state.version;

  // Get current reminder IDs
  const newIds = new Set(state.reminders.map((r) => r.id));

  // Cancel jobs for removed reminders
  for (const [id, job] of activeJobs) {
    if (!newIds.has(id)) {
      console.log(`[Scheduler] Removing: ${id}`);
      job.cancel();
      activeJobs.delete(id);
    }
  }

  // Schedule new/updated reminders
  for (const reminder of state.reminders) {
    scheduleReminder(reminder);
  }
}

/**
 * Watch schedule file for changes
 */
function watchScheduleFile(): void {
  if (!existsSync(SCHEDULE_FILE)) {
    console.log(
      `[Scheduler] Schedule file not found, will create on first reminder`,
    );
    return;
  }

  const watcher = watch(SCHEDULE_FILE, async (eventType) => {
    if (eventType === "change") {
      // Debounce rapid changes
      await new Promise((resolve) => setTimeout(resolve, 100));
      await syncSchedule();
    }
  });

  watcher.on("error", (error) => {
    console.error("[Scheduler] Watch error:", error);
  });

  console.log(`[Scheduler] Watching: ${SCHEDULE_FILE}`);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log("[Scheduler] Starting...");
  console.log(`[Scheduler] MEMORY_DIR: ${MEMORY_DIR}`);
  console.log(`[Scheduler] OPENCODE_URL: ${OPENCODE_URL}`);

  // Initial sync
  await syncSchedule();

  // Watch for changes
  watchScheduleFile();

  // Also poll every minute in case file watch misses changes
  setInterval(() => {
    syncSchedule().catch(console.error);
  }, 60 * 1000);

  console.log("[Scheduler] Running. Press Ctrl+C to stop.");

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n[Scheduler] Shutting down...");
    for (const job of activeJobs.values()) {
      job.cancel();
    }
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.log("[Scheduler] Received SIGTERM, shutting down...");
    for (const job of activeJobs.values()) {
      job.cancel();
    }
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("[Scheduler] Fatal error:", error);
  process.exit(1);
});
