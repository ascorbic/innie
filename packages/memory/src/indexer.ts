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
import { join } from "path";
import { readFile, readdir, stat, mkdir, writeFile } from "fs/promises";
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
export type MemoryItemType =
  | "journal"
  | "state"
  | "project"
  | "person"
  | "meeting"
  | "topic";

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
  id?: string;
  related?: RelatedItem[];
}

export interface RelatedItem {
  id: string;
  type: MemoryItemType;
  source: string;
  snippet: string;
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
 * Search the index, with optional related items for each result
 */
export async function searchMemory(
  query: string,
  options: {
    limit?: number;
    type?: MemoryItemType;
    since?: string; // ISO date
    includeRelated?: boolean; // Fetch 3 related items per result
  } = {},
): Promise<SearchResult[]> {
  const { limit = 5, type, since, includeRelated = true } = options;
  const idx = await getIndex();

  // Check if index has items
  const stats = await idx.listItems();
  if (stats.length === 0) {
    console.error("[Memory] Index is empty");
    return [];
  }

  const queryVector = await embed(query);

  // Vectra's queryItems signature: (vector, topK, filter?)
  const results = await idx.queryItems(queryVector, limit * 2);

  // Filter results if type or since specified
  let filtered = results;
  if (type || since) {
    filtered = results.filter((item) => {
      const meta = item.item.metadata as Record<string, unknown>;
      if (type && meta.type !== type) return false;
      if (since && meta.timestamp && (meta.timestamp as string) < since)
        return false;
      return true;
    });
  }

  const topResults = filtered.slice(0, limit);

  // Build set of IDs we're already returning (to avoid duplicates in related)
  const returnedIds = new Set(topResults.map((r) => r.item.id));

  return Promise.all(
    topResults.map(async (r) => {
      const meta = r.item.metadata as Record<string, unknown>;
      const result: SearchResult = {
        id: r.item.id,
        content: meta.content as string,
        source: meta.source as string,
        section: meta.section as string | undefined,
        timestamp: meta.timestamp as string | undefined,
        type: meta.type as MemoryItemType,
        score: r.score,
      };

      // Find related items using the result's own embedding
      if (includeRelated) {
        const itemVector = await embed(meta.content as string);
        const related = await idx.queryItems(itemVector, 8);

        result.related = related
          .filter(
            (rel) =>
              rel.item.id !== r.item.id &&
              !returnedIds.has(rel.item.id) &&
              rel.score > 0.4,
          )
          .slice(0, 3)
          .map((rel) => {
            const relMeta = rel.item.metadata as Record<string, unknown>;
            const content = relMeta.content as string;
            return {
              id: rel.item.id,
              type: relMeta.type as MemoryItemType,
              source: relMeta.source as string,
              snippet:
                content.slice(0, 80) + (content.length > 80 ? "..." : ""),
              score: rel.score,
            };
          });
      }

      return result;
    }),
  );
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
  type: MemoryItemType,
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
        files.push(...(await findMarkdownFiles(fullPath)));
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
 * Generate topics.md - an index of all topic files for context injection
 * Format: `- filename.md - Title`
 */
async function generateTopicsIndex(): Promise<void> {
  const topicsDir = join(STATE_PATH, "topics");
  const outputPath = join(STATE_PATH, "topics.md");

  try {
    const files = await findMarkdownFiles(topicsDir);
    const entries: { filename: string; title: string }[] = [];

    for (const file of files) {
      const content = await readFile(file, "utf-8");
      const filename = file.split("/").pop() || file;

      // Extract H1 title from content
      const titleMatch = content.match(/^#\s+(.+)$/m);
      const title = titleMatch ? titleMatch[1] : filename.replace(/\.md$/, "");

      entries.push({ filename, title });
    }

    // Sort alphabetically by title
    entries.sort((a, b) => a.title.localeCompare(b.title));

    // Generate markdown
    const lines = [
      "# Topics",
      "",
      "Working knowledge - distilled understanding of concepts and tools.",
      "",
    ];
    for (const { filename, title } of entries) {
      lines.push(`- ${filename} - ${title}`);
    }
    lines.push("");

    await writeFile(outputPath, lines.join("\n"));
    console.error(
      `[Memory] Generated topics.md with ${entries.length} entries`,
    );
  } catch (error) {
    console.error("[Memory] Failed to generate topics.md:", error);
  }
}

/**
 * Rebuild the entire index from scratch
 * Journal entries are indexed with associative links
 */
export async function rebuildIndex(): Promise<{ itemCount: number }> {
  console.error("[Memory] Starting full index rebuild...");
  const startTime = Date.now();

  const idx = await getIndex();

  // Clear existing index
  console.error("[Memory] Clearing existing index...");
  const existingItems = await idx.listItems();
  for (const item of existingItems) {
    await idx.deleteItem(item.id);
  }

  // 1. Index non-journal items first (state, projects, people, meetings)
  const nonJournalItems: MemoryItem[] = [];

  // 2. Index state files
  console.error("[Memory] Parsing state files...");
  const stateFiles = [
    "today.md",
    "inbox.md",
    "commitments.md",
    "ambient-tasks.md",
  ];
  for (const file of stateFiles) {
    const items = await parseMarkdownForIndexing(
      join(STATE_PATH, file),
      "state",
    );
    nonJournalItems.push(...items);
  }

  // 3. Index project files
  console.error("[Memory] Parsing projects...");
  const projectFiles = await findMarkdownFiles(join(STATE_PATH, "projects"));
  for (const file of projectFiles) {
    const items = await parseMarkdownForIndexing(file, "project");
    nonJournalItems.push(...items);
  }

  // 4. Index people files
  console.error("[Memory] Parsing people...");
  const peopleFiles = await findMarkdownFiles(join(STATE_PATH, "people"));
  for (const file of peopleFiles) {
    const items = await parseMarkdownForIndexing(file, "person");
    nonJournalItems.push(...items);
  }

  // 5. Index meeting files
  console.error("[Memory] Parsing meetings...");
  const meetingFiles = await findMarkdownFiles(join(STATE_PATH, "meetings"));
  for (const file of meetingFiles) {
    const items = await parseMarkdownForIndexing(file, "meeting");
    nonJournalItems.push(...items);
  }

  // 6. Index topic files (working knowledge) - as whole files, not sections
  console.error("[Memory] Parsing topics...");
  const topicFiles = await findMarkdownFiles(join(STATE_PATH, "topics"));
  for (const file of topicFiles) {
    try {
      const content = await readFile(file, "utf-8");
      const filename = file.split("/").pop() || file;
      nonJournalItems.push({
        id: `topic-${filename}`,
        type: "topic",
        content: content.trim(),
        source: file,
      });
    } catch {
      // Skip unreadable files
    }
  }

  // Batch index non-journal items
  console.error(
    `[Memory] Indexing ${nonJournalItems.length} non-journal items...`,
  );
  await indexItems(nonJournalItems);

  // Generate topics.md index
  await generateTopicsIndex();

  // 6. Index journal entries one by one to build associative links
  console.error("[Memory] Parsing and linking journal entries...");
  const journalPath = join(LOGS_PATH, "journal.jsonl");
  let journalCount = 0;

  try {
    const content = await readFile(journalPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    for (const line of lines) {
      const entry: JournalEntry = JSON.parse(line);
      await indexJournalEntry(entry);
      journalCount++;

      // Progress indicator every 10 entries
      if (journalCount % 10 === 0) {
        console.error(
          `[Memory] Indexed ${journalCount}/${lines.length} journal entries...`,
        );
      }
    }
  } catch {
    // Journal may not exist
  }

  const totalItems = nonJournalItems.length + journalCount;

  const duration = Date.now() - startTime;
  console.error(`[Memory] Index rebuild complete in ${duration}ms`);

  return { itemCount: totalItems };
}

/**
 * Index a single new journal entry (for incremental updates)
 * Also finds and stores links to the most similar existing entries
 */
export async function indexJournalEntry(
  entry: JournalEntry,
): Promise<{ relatedIds: string[] }> {
  const idx = await getIndex();
  const content = `[${entry.topic}] ${entry.content}`;
  const vector = await embed(content);
  const id = `journal-${entry.timestamp}`;

  const metadata: Record<string, string | number | boolean> = {
    type: "journal",
    content,
    source: "journal.jsonl",
    timestamp: entry.timestamp,
  };

  await idx.upsertItem({
    id,
    vector,
    metadata,
  });
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
 * Get an entry by ID with its semantically related entries (computed at query time)
 */
export async function getEntryWithRelated(
  id: string,
): Promise<{ entry: SearchResult | null; related: RelatedItem[] }> {
  const idx = await getIndex();

  // Get the entry
  const item = await idx.getItem(id);
  if (!item) {
    return { entry: null, related: [] };
  }

  const meta = item.metadata as Record<string, unknown>;
  const content = meta.content as string;

  const entry: SearchResult = {
    id: item.id,
    content,
    source: meta.source as string,
    section: meta.section as string | undefined,
    timestamp: meta.timestamp as string | undefined,
    type: meta.type as MemoryItemType,
    score: 1.0,
  };

  // Find related entries via semantic search
  const itemVector = await embed(content);
  const similar = await idx.queryItems(itemVector, 6);

  const related: RelatedItem[] = similar
    .filter((rel) => rel.item.id !== id && rel.score > 0.4)
    .slice(0, 5)
    .map((rel) => {
      const relMeta = rel.item.metadata as Record<string, unknown>;
      const relContent = relMeta.content as string;
      return {
        id: rel.item.id,
        type: relMeta.type as MemoryItemType,
        snippet:
          relContent.slice(0, 100) + (relContent.length > 100 ? "..." : ""),
        score: rel.score,
      };
    });

  return { entry, related };
}

/**
 * Index a file directly (for incremental updates from hooks)
 *
 * Called by the file.edited hook when state files are modified.
 * Parses the file and updates all its items in the index.
 * Topics are indexed as whole files; other types are split by ## sections.
 */
export async function indexFile(
  filePath: string,
  content: string,
  type: MemoryItemType,
): Promise<{ itemCount: number }> {
  const filename = filePath.split("/").pop() || filePath;
  console.error(`[Memory] Indexing file: ${filename} (${type})`);

  // Topics are indexed as whole files, not split by sections
  if (type === "topic") {
    const item: MemoryItem = {
      id: `topic-${filename}`,
      type: "topic",
      content: content.trim(),
      source: filePath,
    };
    await indexItem(item);

    // Regenerate topics.md index
    await generateTopicsIndex();

    return { itemCount: 1 };
  }

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
