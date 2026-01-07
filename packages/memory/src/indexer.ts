/**
 * Memory Indexer
 *
 * Manages the vector index for semantic search over:
 * - Journal entries
 * - State files (today, inbox, commitments)
 * - Project files
 * - People files
 * - Meeting briefings
 *
 * Uses Vectra for storage and embeddings.ts for vector generation.
 */

import { LocalIndex } from "vectra";
import { join, dirname } from "path";
import { readFile, readdir, stat, mkdir } from "fs/promises";
import { embed, embedBatch } from "./embeddings.js";

// MEMORY_DIR is the base directory, with fallback to legacy vars
const MEMORY_DIR = process.env.MEMORY_DIR;
const STATE_PATH = MEMORY_DIR
  ? join(MEMORY_DIR, "state")
  : process.env.INNIE_STATE_PATH || join(process.cwd(), "state");
const LOGS_PATH = MEMORY_DIR
  ? join(MEMORY_DIR, "logs")
  : process.env.INNIE_LOGS_PATH || join(process.cwd(), "logs");
const INDEX_PATH = join(STATE_PATH, ".memory-index");

// Item types for filtering
export type MemoryItemType = "journal" | "state" | "project" | "person" | "meeting";

export interface MemoryItem {
  id: string;
  type: MemoryItemType;
  content: string;
  source: string; // File path or "journal"
  section?: string; // For markdown sections
  timestamp?: string; // ISO date
}

export interface SearchResult {
  content: string;
  source: string;
  section?: string;
  timestamp?: string;
  type: MemoryItemType;
  score: number;
}

export interface JournalEntry {
  timestamp: string;
  topic: string;
  agentIntent?: string;
  content: string;
}

// Singleton index instance
let index: LocalIndex | null = null;

/**
 * Get or create the vector index
 */
async function getIndex(): Promise<LocalIndex> {
  if (index) return index;

  // Ensure index directory exists
  await mkdir(INDEX_PATH, { recursive: true });

  index = new LocalIndex(INDEX_PATH);

  // Create if doesn't exist
  if (!(await index.isIndexCreated())) {
    console.error("[Memory] Creating new index...");
    await index.createIndex();
  }

  return index;
}

/**
 * Add or update a single item in the index
 */
export async function indexItem(item: MemoryItem): Promise<void> {
  const idx = await getIndex();
  const vector = await embed(item.content);

  // Vectra requires all metadata values to be defined (string | number | boolean)
  const metadata: Record<string, string | number | boolean> = {
    type: item.type,
    content: item.content,
    source: item.source,
  };
  if (item.section) metadata.section = item.section;
  if (item.timestamp) metadata.timestamp = item.timestamp;

  await idx.upsertItem({
    id: item.id,
    vector,
    metadata,
  });
}

/**
 * Add or update multiple items (batched for efficiency)
 */
export async function indexItems(items: MemoryItem[]): Promise<void> {
  if (items.length === 0) return;

  const idx = await getIndex();
  const vectors = await embedBatch(items.map((i) => i.content));

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const metadata: Record<string, string | number | boolean> = {
      type: item.type,
      content: item.content,
      source: item.source,
    };
    if (item.section) metadata.section = item.section;
    if (item.timestamp) metadata.timestamp = item.timestamp;

    await idx.upsertItem({
      id: item.id,
      vector: vectors[i],
      metadata,
    });
  }
}

/**
 * Search the index
 */
export async function searchMemory(
  query: string,
  options: {
    limit?: number;
    type?: MemoryItemType;
    since?: string; // ISO date
  } = {}
): Promise<SearchResult[]> {
  const { limit = 5, type, since } = options;
  const idx = await getIndex();

  // Check if index has items
  const stats = await idx.listItems();
  if (stats.length === 0) {
    console.error("[Memory] Index is empty");
    return [];
  }

  const queryVector = await embed(query);

  // Vectra's queryItems signature: (vector, query, topK, filter?, isBm25?)
  const results = await idx.queryItems(queryVector, query, limit * 2);

  // Filter results if type or since specified
  let filtered = results;
  if (type || since) {
    filtered = results.filter((item) => {
      const meta = item.item.metadata as Record<string, unknown>;
      if (type && meta.type !== type) return false;
      if (since && meta.timestamp && (meta.timestamp as string) < since) return false;
      return true;
    });
  }

  return filtered.slice(0, limit).map((r) => {
    const meta = r.item.metadata as Record<string, unknown>;
    return {
      content: meta.content as string,
      source: meta.source as string,
      section: meta.section as string | undefined,
      timestamp: meta.timestamp as string | undefined,
      type: meta.type as MemoryItemType,
      score: r.score,
    };
  });
}

/**
 * Parse journal.jsonl and return items for indexing
 */
async function parseJournalForIndexing(): Promise<MemoryItem[]> {
  const journalPath = join(LOGS_PATH, "journal.jsonl");

  try {
    const content = await readFile(journalPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    return lines.map((line, i) => {
      const entry: JournalEntry = JSON.parse(line);
      return {
        id: `journal-${entry.timestamp}-${i}`,
        type: "journal" as const,
        content: `[${entry.topic}] ${entry.content}`,
        source: "journal.jsonl",
        timestamp: entry.timestamp,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Parse a markdown file into sections for indexing
 */
async function parseMarkdownForIndexing(
  filePath: string,
  type: MemoryItemType
): Promise<MemoryItem[]> {
  try {
    const content = await readFile(filePath, "utf-8");
    const filename = filePath.split("/").pop() || filePath;

    // Split by ## headers
    const sections = content.split(/^## /m);
    const items: MemoryItem[] = [];

    // First section (before any ##) is the preamble
    if (sections[0].trim()) {
      items.push({
        id: `${type}-${filename}-preamble`,
        type,
        content: sections[0].trim(),
        source: filePath,
        section: "preamble",
      });
    }

    // Each subsequent section
    for (let i = 1; i < sections.length; i++) {
      const section = sections[i];
      const firstLine = section.split("\n")[0];
      const sectionTitle = firstLine.trim();
      const sectionContent = section.slice(firstLine.length).trim();

      if (sectionContent) {
        items.push({
          id: `${type}-${filename}-${i}`,
          type,
          content: `## ${sectionTitle}\n\n${sectionContent}`,
          source: filePath,
          section: sectionTitle,
        });
      }
    }

    return items;
  } catch {
    return [];
  }
}

/**
 * Recursively find all .md files in a directory
 */
async function findMarkdownFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...await findMarkdownFiles(fullPath));
      } else if (entry.name.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  } catch {
    // Directory may not exist
  }

  return files;
}

/**
 * Rebuild the entire index from scratch
 */
export async function rebuildIndex(): Promise<{ itemCount: number }> {
  console.error("[Memory] Starting full index rebuild...");
  const startTime = Date.now();

  const allItems: MemoryItem[] = [];

  // 1. Index journal entries
  console.error("[Memory] Parsing journal...");
  const journalItems = await parseJournalForIndexing();
  allItems.push(...journalItems);

  // 2. Index state files
  console.error("[Memory] Parsing state files...");
  const stateFiles = ["today.md", "inbox.md", "commitments.md", "ambient-tasks.md"];
  for (const file of stateFiles) {
    const items = await parseMarkdownForIndexing(join(STATE_PATH, file), "state");
    allItems.push(...items);
  }

  // 3. Index project files
  console.error("[Memory] Parsing projects...");
  const projectFiles = await findMarkdownFiles(join(STATE_PATH, "projects"));
  for (const file of projectFiles) {
    const items = await parseMarkdownForIndexing(file, "project");
    allItems.push(...items);
  }

  // 4. Index people files
  console.error("[Memory] Parsing people...");
  const peopleFiles = await findMarkdownFiles(join(STATE_PATH, "people"));
  for (const file of peopleFiles) {
    const items = await parseMarkdownForIndexing(file, "person");
    allItems.push(...items);
  }

  // 5. Index meeting files
  console.error("[Memory] Parsing meetings...");
  const meetingFiles = await findMarkdownFiles(join(STATE_PATH, "meetings"));
  for (const file of meetingFiles) {
    const items = await parseMarkdownForIndexing(file, "meeting");
    allItems.push(...items);
  }

  // Index all items
  console.error(`[Memory] Indexing ${allItems.length} items...`);
  await indexItems(allItems);

  const duration = Date.now() - startTime;
  console.error(`[Memory] Index rebuild complete in ${duration}ms`);

  return { itemCount: allItems.length };
}

/**
 * Index a single new journal entry (for incremental updates)
 */
export async function indexJournalEntry(entry: JournalEntry): Promise<void> {
  const item: MemoryItem = {
    id: `journal-${entry.timestamp}`,
    type: "journal",
    content: `[${entry.topic}] ${entry.content}`,
    source: "journal.jsonl",
    timestamp: entry.timestamp,
  };
  await indexItem(item);
}

/**
 * Get index stats
 */
export async function getIndexStats(): Promise<{ itemCount: number }> {
  const idx = await getIndex();
  const items = await idx.listItems();
  return { itemCount: items.length };
}

/**
 * Index a file directly (for incremental updates from hooks)
 *
 * Called by the file.edited hook when state files are modified.
 * Parses the file and updates all its items in the index.
 */
export async function indexFile(
  filePath: string,
  content: string,
  type: MemoryItemType
): Promise<{ itemCount: number }> {
  const filename = filePath.split("/").pop() || filePath;
  console.error(`[Memory] Indexing file: ${filename} (${type})`);

  // Parse file into sections
  const sections = content.split(/^## /m);
  const items: MemoryItem[] = [];

  // First section (before any ##) is the preamble
  if (sections[0]?.trim()) {
    items.push({
      id: `${type}-${filename}-preamble`,
      type,
      content: sections[0].trim(),
      source: filePath,
      section: "preamble",
    });
  }

  // Each subsequent section
  for (let i = 1; i < sections.length; i++) {
    const section = sections[i];
    if (!section) continue;
    const firstLine = section.split("\n")[0] || "";
    const sectionTitle = firstLine.trim();
    const sectionContent = section.slice(firstLine.length).trim();

    if (sectionContent) {
      items.push({
        id: `${type}-${filename}-${i}`,
        type,
        content: `## ${sectionTitle}\n\n${sectionContent}`,
        source: filePath,
        section: sectionTitle,
      });
    }
  }

  // Index all items (upsert will update existing)
  if (items.length > 0) {
    await indexItems(items);
  }

  return { itemCount: items.length };
}
