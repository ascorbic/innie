/**
 * Scheduler state management
 *
 * The memory MCP provides tools to read/write the schedule.
 * A separate daemon process watches the schedule file and triggers events.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const MEMORY_DIR = process.env.MEMORY_DIR || path.join(process.env.HOME || "", ".innie");
const SCHEDULE_FILE = path.join(MEMORY_DIR, "schedule.json");

export interface ScheduledReminder {
  id: string;
  type: "cron" | "once";
  /** Cron expression (for recurring) or ISO date (for one-shot) */
  schedule: string;
  description: string;
  payload: string;
  createdAt: string;
  lastRun?: string;
  /** Optional model override (e.g., "anthropic/claude-sonnet-4-20250514" for deep thinking tasks) */
  model?: string;
}

export interface ScheduleState {
  reminders: ScheduledReminder[];
  version: number;
}

/**
 * Load schedule state from file
 */
export async function loadSchedule(): Promise<ScheduleState> {
  try {
    if (!existsSync(SCHEDULE_FILE)) {
      return { reminders: [], version: 1 };
    }
    const content = await readFile(SCHEDULE_FILE, "utf-8");
    return JSON.parse(content) as ScheduleState;
  } catch {
    return { reminders: [], version: 1 };
  }
}

/**
 * Save schedule state to file
 */
export async function saveSchedule(state: ScheduleState): Promise<void> {
  await mkdir(path.dirname(SCHEDULE_FILE), { recursive: true });
  await writeFile(SCHEDULE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Add a recurring reminder (cron-based)
 */
export async function addCronReminder(
  id: string,
  cronExpression: string,
  description: string,
  payload: string,
  model?: string
): Promise<ScheduledReminder> {
  const state = await loadSchedule();

  // Remove existing reminder with same ID
  state.reminders = state.reminders.filter(r => r.id !== id);

  const reminder: ScheduledReminder = {
    id,
    type: "cron",
    schedule: cronExpression,
    description,
    payload,
    createdAt: new Date().toISOString(),
    ...(model && { model }),
  };

  state.reminders.push(reminder);
  state.version++;
  await saveSchedule(state);

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
  model?: string
): Promise<ScheduledReminder> {
  const state = await loadSchedule();

  // Remove existing reminder with same ID
  state.reminders = state.reminders.filter(r => r.id !== id);

  const reminder: ScheduledReminder = {
    id,
    type: "once",
    schedule: datetime,
    description,
    payload,
    createdAt: new Date().toISOString(),
    ...(model && { model }),
  };

  state.reminders.push(reminder);
  state.version++;
  await saveSchedule(state);

  return reminder;
}

/**
 * Remove a reminder by ID
 */
export async function removeReminder(id: string): Promise<boolean> {
  const state = await loadSchedule();
  const before = state.reminders.length;
  state.reminders = state.reminders.filter(r => r.id !== id);

  if (state.reminders.length < before) {
    state.version++;
    await saveSchedule(state);
    return true;
  }
  return false;
}

/**
 * List all reminders
 */
export async function listReminders(): Promise<ScheduledReminder[]> {
  const state = await loadSchedule();
  return state.reminders;
}

/**
 * Mark a reminder as run (update lastRun timestamp)
 */
export async function markReminderRun(id: string): Promise<void> {
  const state = await loadSchedule();
  const reminder = state.reminders.find(r => r.id === id);
  if (reminder) {
    reminder.lastRun = new Date().toISOString();
    state.version++;
    await saveSchedule(state);
  }
}

/**
 * Get the schedule file path (for the daemon to watch)
 */
export function getScheduleFilePath(): string {
  return SCHEDULE_FILE;
}
