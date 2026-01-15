/**
 * Scheduler state management
 *
 * Each reminder is stored as a separate file in reminders/ directory.
 * This prevents contention when multiple reminders fire simultaneously.
 */

import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const MEMORY_DIR =
  process.env.MEMORY_DIR || path.join(process.env.HOME || "", ".innie");
const REMINDERS_DIR = path.join(MEMORY_DIR, "reminders");

export interface ScheduledReminder {
  id: string;
  type: "cron" | "once";
  /** Cron expression (for recurring) or ISO date (for one-shot) */
  schedule: string;
  description: string;
  payload: string;
  createdAt: string;
  lastRun?: string;
  /** Optional model override (e.g., "anthropic/claude-opus-4-5" for deep thinking tasks) */
  model?: string;
}

/**
 * Get the path to a reminder file
 */
function getReminderPath(id: string): string {
  // Sanitize ID for filesystem safety
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(REMINDERS_DIR, `${safeId}.json`);
}

/**
 * Ensure reminders directory exists
 */
async function ensureRemindersDir(): Promise<void> {
  if (!existsSync(REMINDERS_DIR)) {
    await mkdir(REMINDERS_DIR, { recursive: true });
  }
}

/**
 * Load a single reminder by ID
 */
export async function loadReminder(
  id: string,
): Promise<ScheduledReminder | null> {
  try {
    const filePath = getReminderPath(id);
    if (!existsSync(filePath)) {
      return null;
    }
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content) as ScheduledReminder;
  } catch {
    return null;
  }
}

/**
 * Save a single reminder
 */
async function saveReminder(reminder: ScheduledReminder): Promise<void> {
  await ensureRemindersDir();
  const filePath = getReminderPath(reminder.id);
  // Write to temp file first, then rename for atomic write
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, JSON.stringify(reminder, null, 2));
  await writeFile(filePath, JSON.stringify(reminder, null, 2));
  // Clean up temp file
  try {
    await unlink(tempPath);
  } catch {
    // Ignore if already gone
  }
}

/**
 * Add a recurring reminder (cron-based)
 */
export async function addCronReminder(
  id: string,
  cronExpression: string,
  description: string,
  payload: string,
  model?: string,
): Promise<ScheduledReminder> {
  const reminder: ScheduledReminder = {
    id,
    type: "cron",
    schedule: cronExpression,
    description,
    payload,
    createdAt: new Date().toISOString(),
    ...(model && { model }),
  };

  await saveReminder(reminder);
  return reminder;
}

/**
 * Add a one-shot reminder
 */
export async function addOnceReminder(
  id: string,
  datetime: string,
  description: string,
  payload: string,
  model?: string,
): Promise<ScheduledReminder> {
  const reminder: ScheduledReminder = {
    id,
    type: "once",
    schedule: datetime,
    description,
    payload,
    createdAt: new Date().toISOString(),
    ...(model && { model }),
  };

  await saveReminder(reminder);
  return reminder;
}

/**
 * Remove a reminder by ID
 */
export async function removeReminder(id: string): Promise<boolean> {
  const filePath = getReminderPath(id);
  if (!existsSync(filePath)) {
    return false;
  }
  try {
    await unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * List all reminders
 */
export async function listReminders(): Promise<ScheduledReminder[]> {
  await ensureRemindersDir();

  try {
    const files = await readdir(REMINDERS_DIR);
    const reminders: ScheduledReminder[] = [];

    for (const file of files) {
      if (!file.endsWith(".json") || file.endsWith(".tmp")) continue;

      try {
        const content = await readFile(path.join(REMINDERS_DIR, file), "utf-8");
        const reminder = JSON.parse(content) as ScheduledReminder;
        reminders.push(reminder);
      } catch {
        // Skip corrupted files
      }
    }

    return reminders;
  } catch {
    return [];
  }
}

/**
 * Mark a reminder as run (update lastRun timestamp)
 */
export async function markReminderRun(id: string): Promise<void> {
  const reminder = await loadReminder(id);
  if (reminder) {
    reminder.lastRun = new Date().toISOString();
    await saveReminder(reminder);
  }
}

/**
 * Get the reminders directory path (for the daemon to watch)
 */
export function getRemindersDir(): string {
  return REMINDERS_DIR;
}

// Legacy export for backwards compatibility during migration
export function getScheduleFilePath(): string {
  return path.join(MEMORY_DIR, "schedule.json");
}
