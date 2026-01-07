#!/usr/bin/env node
/**
 * Scheduler Daemon for Innie
 *
 * Watches schedule.json and triggers opencode when events are due.
 * Designed to be run as a persistent daemon via launchd.
 *
 * Environment variables:
 * - MEMORY_DIR: Path to memory directory (default: ~/.innie)
 * - OPENCODE_PATH: Path to opencode binary (default: opencode)
 * - OPENCODE_PROJECT: Project directory for opencode (default: cwd)
 */

import { spawn } from "node:child_process";
import { watch, existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import schedule from "node-schedule";

const MEMORY_DIR = process.env.MEMORY_DIR || path.join(process.env.HOME || "", ".innie");
const SCHEDULE_FILE = path.join(MEMORY_DIR, "schedule.json");
const OPENCODE_PATH = process.env.OPENCODE_PATH || "opencode";
const OPENCODE_PROJECT = process.env.OPENCODE_PROJECT || process.cwd();

interface ScheduledReminder {
  id: string;
  type: "cron" | "once";
  schedule: string;
  description: string;
  payload: string;
  createdAt: string;
  lastRun?: string;
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
  const reminder = state.reminders.find(r => r.id === id);
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
  state.reminders = state.reminders.filter(r => r.id !== id);
  state.version++;
  currentVersion = state.version;
  await saveSchedule(state);
}

/**
 * Trigger opencode with a payload
 */
async function triggerOpencode(reminder: ScheduledReminder): Promise<void> {
  console.log(`[Scheduler] Triggering: ${reminder.description}`);

  const payload = `[Scheduled reminder: ${reminder.description}]\n\n${reminder.payload}`;

  return new Promise((resolve, reject) => {
    const proc = spawn(OPENCODE_PATH, [payload], {
      cwd: OPENCODE_PROJECT,
      stdio: "inherit",
      env: {
        ...process.env,
        MEMORY_DIR,
      },
    });

    proc.on("close", async (code) => {
      if (code === 0) {
        console.log(`[Scheduler] Completed: ${reminder.description}`);
        await markReminderRun(reminder.id);

        // Remove one-shot reminders after they fire
        if (reminder.type === "once") {
          await removeOnceReminder(reminder.id);
          activeJobs.get(reminder.id)?.cancel();
          activeJobs.delete(reminder.id);
        }
      } else {
        console.error(`[Scheduler] Failed with code ${code}: ${reminder.description}`);
      }
      resolve();
    });

    proc.on("error", (error) => {
      console.error(`[Scheduler] Error spawning opencode:`, error);
      reject(error);
    });
  });
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
      console.log(`[Scheduler] Skipping past reminder: ${reminder.description}`);
      return;
    }
    job = schedule.scheduleJob(reminder.id, date, () => {
      triggerOpencode(reminder).catch(console.error);
    });
  }

  if (job) {
    activeJobs.set(reminder.id, job);
    const nextRun = job.nextInvocation();
    console.log(`[Scheduler] Scheduled: ${reminder.description} (next: ${nextRun?.toISOString() || "N/A"})`);
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

  console.log(`[Scheduler] Syncing schedule (version ${currentVersion} -> ${state.version})`);
  currentVersion = state.version;

  // Get current reminder IDs
  const newIds = new Set(state.reminders.map(r => r.id));

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
    console.log(`[Scheduler] Schedule file not found, will create on first reminder`);
    return;
  }

  const watcher = watch(SCHEDULE_FILE, async (eventType) => {
    if (eventType === "change") {
      // Debounce rapid changes
      await new Promise(resolve => setTimeout(resolve, 100));
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
  console.log(`[Scheduler] OPENCODE_PATH: ${OPENCODE_PATH}`);
  console.log(`[Scheduler] OPENCODE_PROJECT: ${OPENCODE_PROJECT}`);

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
