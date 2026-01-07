/**
 * Journal Logging System
 *
 * Provides temporal awareness through JSONL logs.
 * Journal entries track interactions, events, and agent thoughts.
 */

import { appendFile, readFile, mkdir } from "fs/promises";
import { join, dirname } from "path";

export interface JournalEntry {
  timestamp: string;
  topic: string;
  agentIntent?: string;
  content: string;
}

export interface ConversationSummary {
  date: string;
  summary: string;
  notes?: string;
  keyDecisions?: string[];
  openThreads?: string[];
  learnedPatterns?: string[];
}

const LOGS_PATH = process.env.INNIE_LOGS_PATH || join(process.cwd(), "logs");
const JOURNAL_PATH = join(LOGS_PATH, "journal.jsonl");
const SUMMARIES_DIR = join(LOGS_PATH, "summaries");

/**
 * Ensure logs directory exists
 */
async function ensureLogsDir(): Promise<void> {
  await mkdir(LOGS_PATH, { recursive: true });
}

/**
 * Write a journal entry
 */
export async function logJournal(
  entry: Omit<JournalEntry, "timestamp">
): Promise<void> {
  await ensureLogsDir();

  const full: JournalEntry = {
    ...entry,
    timestamp: new Date().toISOString(),
  };
  await appendFile(JOURNAL_PATH, JSON.stringify(full) + "\n");
}

/**
 * Retrieve recent journal entries
 */
export async function getRecentJournalEntries(
  count: number = 40
): Promise<JournalEntry[]> {
  try {
    const content = await readFile(JOURNAL_PATH, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines.slice(-count).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/**
 * Format journal entries for context injection
 */
export function formatJournalForContext(entries: JournalEntry[]): string {
  if (entries.length === 0) {
    return "(no entries)";
  }

  return entries
    .map((e) => {
      const parts = [`[${e.timestamp}] ${e.topic}`];
      if (e.agentIntent) {
        parts.push(`Intent: ${e.agentIntent}`);
      }
      parts.push(e.content.slice(0, 200));
      return parts.join("\n  ");
    })
    .join("\n\n");
}

/**
 * Save a conversation summary
 */
export async function saveConversationSummary(
  summary: ConversationSummary
): Promise<void> {
  await mkdir(SUMMARIES_DIR, { recursive: true });

  // Use full ISO timestamp for filename
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${timestamp}.json`;
  const { writeFile } = await import("fs/promises");
  await writeFile(join(SUMMARIES_DIR, filename), JSON.stringify(summary, null, 2));
}

/**
 * Get recent conversation summaries
 */
export async function getRecentSummaries(
  count: number = 7
): Promise<ConversationSummary[]> {
  try {
    const { readdir, readFile } = await import("fs/promises");
    const files = await readdir(SUMMARIES_DIR);

    const jsonFiles = files
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse()
      .slice(0, count);

    const summaries: ConversationSummary[] = [];
    for (const file of jsonFiles) {
      try {
        const content = await readFile(join(SUMMARIES_DIR, file), "utf-8");
        summaries.push(JSON.parse(content));
      } catch {
        // Skip malformed files
      }
    }

    return summaries;
  } catch {
    return [];
  }
}
