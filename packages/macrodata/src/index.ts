/**
 * Macrodata - Cloud Memory MCP Server
 *
 * A remote MCP server that provides persistent memory for coding agents.
 * Built on Cloudflare Workers with Vectorize for semantic search.
 */

import "./types"; // Extend Env with secrets
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { generateText } from "ai";
import { searchWeb, searchNews } from "./web-search";
import { fetchPageAsMarkdown } from "./web-fetch";
import { createModel, formatModelOptions } from "./models";

// Embedding model: 768 dimensions
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

// State file types
type StateType = "identity" | "today" | "topic" | "project" | "person";

// Database row types
type StateRow = {
  id: string;
  type: string;
  name: string;
  content: string;
  updated_at: string;
};

type JournalRow = {
  id: string;
  topic: string;
  content: string;
  intent: string | null;
  timestamp: string;
};

export class MemoryAgent extends McpAgent<Env> {
  // URLs allowed to be fetched (from search results or user input)
  private allowedUrls: Set<string> = new Set();

  server = new McpServer({
    name: "Macrodata",
    version: "0.1.0",
  });

  /** Initialize SQLite schema */
  private initSchema() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS state_files (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_state_type ON state_files(type);
      CREATE INDEX IF NOT EXISTS idx_state_type_name ON state_files(type, name);

      CREATE TABLE IF NOT EXISTS journal (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        content TEXT NOT NULL,
        intent TEXT,
        timestamp TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_journal_timestamp ON journal(timestamp);
      CREATE INDEX IF NOT EXISTS idx_journal_topic ON journal(topic);
    `);
  }

  /** Get a state file by type and name */
  private getState(type: StateType, name: string): StateRow | null {
    const result = this.ctx.storage.sql
      .exec<StateRow>(
        "SELECT * FROM state_files WHERE type = ? AND name = ?",
        type,
        name,
      )
      .toArray();
    return result[0] ?? null;
  }

  /** Get all state files of a type */
  private getStatesByType(type: StateType): StateRow[] {
    return this.ctx.storage.sql
      .exec<StateRow>("SELECT * FROM state_files WHERE type = ?", type)
      .toArray();
  }

  /** Save a state file (SQLite + Vectorize) */
  private async saveState(
    type: StateType,
    name: string,
    content: string,
  ): Promise<void> {
    const id = `state-${type}-${name}`;
    const now = new Date().toISOString();

    // Save to SQLite
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO state_files (id, type, name, content, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      id,
      type,
      name,
      content,
      now,
    );

    // Sync to Vectorize for semantic search
    const embedding = await this.getEmbedding(`${type} ${name}: ${content}`);
    await this.env.VECTORIZE.upsert([
      {
        id,
        values: embedding,
        metadata: { type, name, content, updatedAt: now },
      },
    ]);
  }

  /** Save a journal entry (SQLite + Vectorize) */
  private async saveJournal(
    topic: string,
    content: string,
    intent?: string,
  ): Promise<string> {
    const id = `journal-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    // Save to SQLite
    this.ctx.storage.sql.exec(
      `INSERT INTO journal (id, topic, content, intent, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
      id,
      topic,
      content,
      intent ?? null,
      now,
    );

    // Sync to Vectorize for semantic search
    const embedding = await this.getEmbedding(`${topic}: ${content}`);
    await this.env.VECTORIZE.upsert([
      {
        id,
        values: embedding,
        metadata: {
          type: "journal",
          topic,
          content,
          intent: intent ?? "",
          timestamp: now,
        },
      },
    ]);

    return id;
  }

  /** Get recent journal entries */
  private getRecentJournal(limit: number = 20): JournalRow[] {
    return this.ctx.storage.sql
      .exec<JournalRow>(
        "SELECT * FROM journal ORDER BY timestamp DESC LIMIT ?",
        limit,
      )
      .toArray();
  }

  async init() {
    // Initialize database schema
    this.initSchema();
    // ==========================================
    // Core Memory Tools
    // ==========================================

    this.server.tool(
      "log_journal",
      "Record an observation, decision, or thing to remember. Entries are searchable via semantic search.",
      {
        topic: z.string().describe("Short topic/category for the entry"),
        content: z.string().describe("The journal entry content"),
        intent: z.string().optional().describe("Why you're logging this"),
      },
      async ({ topic, content, intent }) => {
        console.log(`[JOURNAL] ${topic}: ${content.slice(0, 50)}...`);
        const id = await this.saveJournal(topic, content, intent);
        console.log(`[JOURNAL] Entry saved with ID: ${id}`);
        return {
          content: [{ type: "text", text: `Journal entry saved: ${topic}` }],
        };
      },
    );

    this.server.tool(
      "search_memory",
      "Search your memory (journal entries, topics, etc.) using semantic search. Returns the most relevant items.",
      {
        query: z.string().describe("What to search for"),
        limit: z
          .number()
          .optional()
          .default(5)
          .describe("Maximum results to return"),
        type: z
          .enum(["all", "journal", "topic", "summary"])
          .optional()
          .default("all")
          .describe("Filter by content type"),
      },
      async ({ query, limit, type }) => {
        console.log(
          `[SEARCH] Query: ${query} (type: ${type}, limit: ${limit})`,
        );
        const embedding = await this.getEmbedding(query);
        const filter = type === "all" ? undefined : { type: { $eq: type } };

        const results = await this.env.VECTORIZE.query(embedding, {
          topK: limit,
          returnMetadata: "all",
          filter,
        });
        console.log(`[SEARCH] Found ${results.matches.length} matches`);
        if (results.matches.length === 0) {
          return {
            content: [{ type: "text", text: "No relevant memories found." }],
          };
        }

        const formatted = results.matches
          .map((m) => {
            const meta = m.metadata as Record<string, string>;
            const score = (m.score * 100).toFixed(0);
            return `[${meta.type}] (${score}% match) ${meta.topic ?? meta.name ?? ""}:\n${meta.content}`;
          })
          .join("\n\n---\n\n");

        return {
          content: [{ type: "text", text: formatted }],
        };
      },
    );

    this.server.tool(
      "get_context",
      "IMPORTANT: Call this at the start of EVERY session to load your identity and state.",
      {},
      async () => {
        // Fetch state from SQLite (deterministic lookups)
        const identityRow = this.getState("identity", "identity");
        const userRow = this.getState("person", "user");
        const todayRow = this.getState("today", "today");
        const recentJournal = this.getRecentJournal(5);
        const schedules = this.getSchedules();

        const identity = identityRow?.content;
        const user = userRow?.content;
        const today = todayRow?.content;

        // Detect first run - no identity means fresh agent
        const isFirstRun = !identity;

        if (isFirstRun) {
          return {
            content: [
              {
                type: "text",
                text: `# First Run - Onboarding Needed

I'm a new agent with no memory. I need to learn about my user before I can help effectively.

## What to Learn

Get to know the user through conversation. Some useful things to understand:
- What they do and what they're working on
- Links to their site, GitHub, LinkedIn, etc. (use \`fetch_page\` to read these and learn more about them)
- How they prefer to communicate (concise vs detailed, formal vs casual)
- Their timezone and typical work schedule (for scheduling reviews)
- What they want help with

Don't interrogate - have a natural conversation. Fetch any links they share to build a richer picture.

## Setup Steps

Once you understand the user:

### 1. Create identity
\`\`\`
write_state(
  type: "identity",
  name: "identity", 
  content: "# [Name]\\n\\nI am a stateful agent for [user]. I help with [focus areas].\\n\\n## Communication Style\\n[based on preferences]\\n\\n## Operating Principles\\n- Write state immediately when something happens\\n- Search memory before claiming ignorance\\n- Capture learnings in the moment"
)
\`\`\`

### 2. Create user profile
\`\`\`
write_state(
  type: "person",
  name: "user",
  content: "# [Name]\\n\\n[Bio from their links]\\n\\n## Role\\n[what they do]\\n\\n## Timezone\\n[e.g., Europe/London]\\n\\n## Work Schedule\\n[e.g., 9am-6pm]"
)
\`\`\`

### 3. Set up end-of-day review
\`\`\`
schedule_recurring(
  id: "end-of-day",
  cron: "0 18 * * 1-5",  // 6pm weekdays - adjust to their schedule
  description: "End of day review",
  task: "reflect",
  payload: "Review today's conversations and activity. Identify key learnings, decisions made, and open threads. Update relevant topics. Note anything to follow up on tomorrow.",
  model: "thinking"  // Use thinking tier for deeper reflection
)
\`\`\`

### 4. Set up weekly memory maintenance
\`\`\`
schedule_recurring(
  id: "memory-maintenance",
  cron: "0 3 * * 0",  // Sunday 3am
  description: "Weekly memory maintenance", 
  task: "cleanup",
  payload: "Review all topics and journal entries from the past week. Consolidate related learnings. Prune outdated information. Identify patterns worth preserving as new topics.",
  model: "thinking"  // Use thinking tier for analysis
)
\`\`\`

Then you're ready to help.`,
              },
            ],
          };
        }

        // Normal context response
        const recent = recentJournal
          .map((j) => `- [${j.topic}] ${j.content}`)
          .join("\n");

        const scheduleSummary =
          schedules.length > 0
            ? schedules
                .map((s) => {
                  const payload = s.payload as { description?: string };
                  return `- ${payload?.description ?? s.id}`;
                })
                .join("\n")
            : "No schedules configured.";

        return {
          content: [
            {
              type: "text",
              text: `## Identity\n${identity}\n\n## User\n${user ?? "No user profile yet."}\n\n## Today\n${today ?? "No focus set for today."}\n\n## Recent Activity\n${recent || "No recent entries."}\n\n## Active Schedules\n${scheduleSummary}`,
            },
          ],
        };
      },
    );

    // ==========================================
    // State File Tools
    // ==========================================

    this.server.tool(
      "write_state",
      "Write or update a state file (identity, today, topic, etc.). State files are mutable documents that represent your current understanding.",
      {
        name: z
          .string()
          .describe(
            "State file name (e.g., 'identity', 'today', 'topic/nextjs')",
          ),
        content: z.string().describe("The content to write"),
        type: z
          .enum(["identity", "today", "topic", "project", "person"])
          .describe("Type of state file"),
      },
      async ({ name, content, type }) => {
        await this.saveState(type, name, content);
        return {
          content: [{ type: "text", text: `Updated ${type}: ${name}` }],
        };
      },
    );

    this.server.tool(
      "read_state",
      "Read a state file by name and type.",
      {
        name: z.string().describe("State file name"),
        type: z
          .enum(["identity", "today", "topic", "project", "person"])
          .describe("Type of state file"),
      },
      async ({ name, type }) => {
        const row = this.getState(type, name);

        if (!row) {
          return {
            content: [
              { type: "text", text: `State file not found: ${type}/${name}` },
            ],
          };
        }

        return {
          content: [{ type: "text", text: `# ${row.name}\n\n${row.content}` }],
        };
      },
    );

    this.server.tool(
      "list_topics",
      "List all topics (your distilled knowledge).",
      {},
      async () => {
        const topics = this.getStatesByType("topic");

        if (topics.length === 0) {
          return { content: [{ type: "text", text: "No topics yet." }] };
        }

        const formatted = topics.map((t) => `- ${t.name}`).join("\n");

        return {
          content: [{ type: "text", text: `## Topics\n\n${formatted}` }],
        };
      },
    );

    // ==========================================
    // Session Tools
    // ==========================================

    this.server.tool(
      "save_conversation_summary",
      "Save a summary of the current conversation for context recovery in future sessions.",
      {
        summary: z
          .string()
          .describe("Brief summary of what was discussed/accomplished"),
        keyDecisions: z
          .array(z.string())
          .optional()
          .describe("Important decisions made"),
        openThreads: z
          .array(z.string())
          .optional()
          .describe("Topics to follow up on"),
        learnedPatterns: z
          .array(z.string())
          .optional()
          .describe("New patterns learned about the user"),
      },
      async ({ summary, keyDecisions, openThreads, learnedPatterns }) => {
        const id = `summary-${new Date().toISOString().slice(0, 10)}-${Date.now()}`;
        const content = [
          summary,
          keyDecisions?.length ? `\nDecisions: ${keyDecisions.join(", ")}` : "",
          openThreads?.length
            ? `\nOpen threads: ${openThreads.join(", ")}`
            : "",
          learnedPatterns?.length
            ? `\nLearned: ${learnedPatterns.join(", ")}`
            : "",
        ].join("");

        const embedding = await this.getEmbedding(content);

        await this.env.VECTORIZE.upsert([
          {
            id,
            values: embedding,
            metadata: {
              type: "summary",
              content,
              summary,
              keyDecisions: JSON.stringify(keyDecisions ?? []),
              openThreads: JSON.stringify(openThreads ?? []),
              learnedPatterns: JSON.stringify(learnedPatterns ?? []),
              timestamp: new Date().toISOString(),
            },
          },
        ]);

        return {
          content: [{ type: "text", text: "Conversation summary saved." }],
        };
      },
    );

    // ==========================================
    // Web Tools
    // ==========================================

    this.server.tool(
      "web_search",
      "Search the web for current information using Brave Search.",
      {
        query: z.string().describe("Search query"),
        count: z
          .number()
          .optional()
          .default(5)
          .describe("Number of results (max 10)"),
      },
      async ({ query, count }) => {
        const apiKey = this.env.BRAVE_SEARCH_API_KEY;
        if (!apiKey) {
          return {
            content: [
              {
                type: "text",
                text: "Error: BRAVE_SEARCH_API_KEY not configured",
              },
            ],
          };
        }

        try {
          const results = await searchWeb(query, apiKey, {
            count: Math.min(count, 10),
          });

          if (results.length === 0) {
            return {
              content: [
                { type: "text", text: `No results found for "${query}"` },
              ],
            };
          }

          for (const r of results) {
            this.allowedUrls.add(r.url);
          }

          const formatted = results
            .map(
              (r) =>
                `**${r.title}**\n${r.url}\n${r.description}${r.age ? ` (${r.age})` : ""}`,
            )
            .join("\n\n");

          return { content: [{ type: "text", text: formatted }] };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Search error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          };
        }
      },
    );

    this.server.tool(
      "news_search",
      "Search for recent news articles using Brave Search.",
      {
        query: z.string().describe("Search query"),
        count: z
          .number()
          .optional()
          .default(5)
          .describe("Number of results (max 10)"),
      },
      async ({ query, count }) => {
        const apiKey = this.env.BRAVE_SEARCH_API_KEY;
        if (!apiKey) {
          return {
            content: [
              {
                type: "text",
                text: "Error: BRAVE_SEARCH_API_KEY not configured",
              },
            ],
          };
        }

        try {
          const results = await searchNews(query, apiKey, {
            count: Math.min(count, 10),
          });

          if (results.length === 0) {
            return {
              content: [{ type: "text", text: `No news found for "${query}"` }],
            };
          }

          for (const r of results) {
            this.allowedUrls.add(r.url);
          }

          const formatted = results
            .map(
              (r) =>
                `**${r.title}**\n${r.url}\n${r.description}${r.age ? ` (${r.age})` : ""}`,
            )
            .join("\n\n");

          return { content: [{ type: "text", text: formatted }] };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `News search error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          };
        }
      },
    );

    this.server.tool(
      "fetch_page",
      "Fetch a webpage and convert to markdown. Only works for URLs from search results.",
      {
        url: z.string().url().describe("URL to fetch"),
        waitForJs: z
          .boolean()
          .optional()
          .default(false)
          .describe("Wait for JavaScript to execute"),
      },
      async ({ url, waitForJs }) => {
        if (!this.allowedUrls.has(url)) {
          return {
            content: [
              {
                type: "text",
                text: `URL not allowed. URLs must come from search results. Use web_search first.`,
              },
            ],
          };
        }

        const apiToken = this.env.CF_API_TOKEN;
        const accountId = this.env.CF_ACCOUNT_ID;
        if (!apiToken || !accountId) {
          return {
            content: [
              {
                type: "text",
                text: "Error: CF_API_TOKEN or CF_ACCOUNT_ID not configured",
              },
            ],
          };
        }

        try {
          const markdown = await fetchPageAsMarkdown(url, accountId, apiToken, {
            waitUntil: waitForJs ? "networkidle0" : undefined,
          });

          const maxLength = 50000;
          if (markdown.length > maxLength) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    markdown.slice(0, maxLength) + "\n\n[Content truncated...]",
                },
              ],
            };
          }

          return { content: [{ type: "text", text: markdown }] };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Fetch error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          };
        }
      },
    );

    // ==========================================
    // Refine Tool - Cloud Agent Deep Processing
    // ==========================================

    this.server.tool(
      "refine",
      "Ask the cloud agent to do deep processing on your memory - consolidation, pattern recognition, cleanup.",
      {
        task: z
          .enum(["consolidate", "reflect", "cleanup", "research"])
          .describe("What kind of refinement to do"),
        focus: z.string().optional().describe("Specific area to focus on"),
      },
      async ({ task, focus }) => {
        const prompts: Record<string, string> = {
          consolidate: `Review recent journal entries and consolidate them into updated topics. Look for patterns, recurring themes, and knowledge worth preserving. ${focus ? `Focus on: ${focus}` : ""}`,
          reflect: `Reflect on recent activity and identify insights, patterns, or things worth remembering. ${focus ? `Focus on: ${focus}` : ""}`,
          cleanup: `Review memory for stale, outdated, or redundant entries. Suggest what to archive or update. ${focus ? `Focus on: ${focus}` : ""}`,
          research: `Research and gather information about: ${focus ?? "recent topics of interest"}.`,
        };

        const context = await this.env.VECTORIZE.query(
          await this.getEmbedding(focus ?? task),
          {
            topK: 10,
            returnMetadata: "all",
          },
        );

        const contextText = context.matches
          .map((m) => {
            const meta = m.metadata as Record<string, string>;
            return `[${meta.type}] ${meta.content}`;
          })
          .join("\n\n");

        // Use "thinking" tier for refinement tasks - they need deeper reasoning
        const model = createModel(this.env, "thinking");

        const { text } = await generateText({
          model,
          prompt: `${prompts[task]}\n\n## Current Memory Context\n\n${contextText}\n\nProvide your analysis and any recommended updates.`,
        });

        return {
          content: [
            { type: "text", text: `## Refinement: ${task}\n\n${text}` },
          ],
        };
      },
    );

    // ==========================================
    // Scheduling Tools
    // ==========================================

    const modelOptions = formatModelOptions();

    this.server.tool(
      "schedule_recurring",
      `Schedule a recurring task using a cron expression. Examples: '0 9 * * 1-5' (9am weekdays), '0 18 * * *' (6pm daily), '0 3 * * 0' (3am Sunday).\n\n${modelOptions}`,
      {
        id: z.string().describe("Unique identifier for this schedule"),
        cron: z
          .string()
          .describe("Cron expression (minute hour day month weekday)"),
        description: z.string().describe("What this schedule does"),
        task: z
          .enum(["consolidate", "reflect", "cleanup", "briefing", "custom"])
          .describe("Type of task to run"),
        payload: z
          .string()
          .optional()
          .describe("Custom instructions for the task"),
        model: z
          .enum(["fast", "thinking", "local"])
          .optional()
          .describe(
            "Model tier: 'fast' (quick), 'thinking' (deep reasoning), 'local' (free). Defaults based on task type.",
          ),
      },
      async ({ id, cron, description, task, payload, model }) => {
        await this.schedule(cron, "runScheduledTask", {
          id,
          task,
          description,
          payload: payload ?? description,
          model,
        });

        return {
          content: [
            {
              type: "text",
              text: `Scheduled recurring task "${description}" with cron: ${cron}`,
            },
          ],
        };
      },
    );

    this.server.tool(
      "schedule_once",
      `Schedule a one-time task at a specific date/time.\n\n${modelOptions}`,
      {
        id: z.string().describe("Unique identifier for this schedule"),
        datetime: z
          .string()
          .describe("ISO 8601 datetime (e.g., '2025-01-23T10:00:00')"),
        description: z.string().describe("What this task does"),
        task: z
          .enum(["consolidate", "reflect", "cleanup", "briefing", "custom"])
          .describe("Type of task to run"),
        payload: z
          .string()
          .optional()
          .describe("Custom instructions for the task"),
        model: z
          .enum(["fast", "thinking", "local"])
          .optional()
          .describe(
            "Model tier: 'fast' (quick), 'thinking' (deep reasoning), 'local' (free). Defaults based on task type.",
          ),
      },
      async ({ id, datetime, description, task, payload, model }) => {
        const date = new Date(datetime);
        await this.schedule(date, "runScheduledTask", {
          id,
          task,
          description,
          payload: payload ?? description,
          model,
        });

        return {
          content: [
            {
              type: "text",
              text: `Scheduled one-time task "${description}" for ${date.toISOString()}`,
            },
          ],
        };
      },
    );

    this.server.tool(
      "list_schedules",
      "List all scheduled tasks.",
      {},
      async () => {
        const schedules = this.getSchedules();

        if (schedules.length === 0) {
          return {
            content: [{ type: "text", text: "No scheduled tasks." }],
          };
        }

        const formatted = schedules
          .map((s) => {
            const payload = s.payload as {
              description?: string;
              task?: string;
            };
            const desc = payload?.description ?? payload?.task ?? "Unknown";
            const typeInfo =
              s.type === "cron"
                ? `cron: ${s.cron}`
                : `once: ${new Date(s.time).toISOString()}`;
            return `- **${s.id}**: ${desc}\n  ${typeInfo}\n  Next: ${s.time ? new Date(s.time).toISOString() : "N/A"}`;
          })
          .join("\n\n");

        return {
          content: [
            { type: "text", text: `## Scheduled Tasks\n\n${formatted}` },
          ],
        };
      },
    );

    this.server.tool(
      "cancel_schedule",
      "Cancel a scheduled task by ID.",
      {
        id: z.string().describe("ID of the schedule to cancel"),
      },
      async ({ id }) => {
        await this.cancelSchedule(id);

        return {
          content: [{ type: "text", text: `Cancelled schedule: ${id}` }],
        };
      },
    );
  }

  // ==========================================
  // Scheduled Task Handler
  // ==========================================

  async runScheduledTask(data: {
    id?: string;
    task: string;
    description?: string;
    payload?: string;
    focus?: string;
    model?: string;
  }) {
    console.log(`[SCHEDULED] Running task: ${data.description ?? data.task}`);

    // Get relevant context for the task
    const searchTerm = data.payload ?? data.description ?? data.task;
    const context = await this.env.VECTORIZE.query(
      await this.getEmbedding(searchTerm),
      {
        topK: 10,
        returnMetadata: "all",
      },
    );

    const contextText = context.matches
      .map((m) => {
        const meta = m.metadata as Record<string, string>;
        return `[${meta.type}] ${meta.content}`;
      })
      .join("\n\n");

    // Build task-specific prompts
    const taskPrompts: Record<string, string> = {
      consolidate:
        "Review the context and consolidate learnings into updated topics. Identify patterns and knowledge worth preserving.",
      reflect:
        "Reflect on recent activity and identify insights, patterns, or things worth remembering.",
      cleanup:
        "Review memory for stale, outdated, or redundant entries. Identify what should be archived or updated.",
      briefing:
        "Prepare a briefing based on the context. Summarize what's important and what needs attention.",
      custom: data.payload ?? "Execute the scheduled task.",
    };

    const prompt = `${taskPrompts[data.task] ?? taskPrompts.custom}

## Context
${contextText}

Provide your analysis and any recommended actions.`;

    // Select model - use specified tier or model ID
    // Default to "thinking" for analysis tasks, "fast" for custom/briefing
    const needsThinking = ["reflect", "cleanup", "consolidate"].includes(
      data.task,
    );
    const defaultModel = needsThinking ? "thinking" : "fast";
    const model = createModel(this.env, data.model ?? defaultModel);

    const { text } = await generateText({
      model,
      prompt,
    });

    // Log the result to journal
    const journalId = `journal-scheduled-${Date.now()}`;
    await this.env.VECTORIZE.upsert([
      {
        id: journalId,
        values: await this.getEmbedding(`scheduled ${data.task}: ${text}`),
        metadata: {
          type: "journal",
          topic: `scheduled-${data.task}`,
          content: text,
          scheduleId: data.id ?? "",
          description: data.description ?? "",
          timestamp: new Date().toISOString(),
        },
      },
    ]);

    console.log(`[SCHEDULED] Task complete: ${data.description ?? data.task}`);
  }

  // ==========================================
  // Helper Methods
  // ==========================================

  private async getEmbedding(text: string): Promise<number[]> {
    const result = await this.env.AI.run(EMBEDDING_MODEL, { text: [text] });
    if ("data" in result && result.data && result.data.length > 0) {
      return result.data[0];
    }
    throw new Error("Failed to generate embedding");
  }
}

// ==========================================
// Worker Entry Point
// ==========================================

import { validateAccessJWT, unauthorizedResponse } from "./auth";

const allowedWorkers = new Set([
  "agents-gateway.workers.dev",
  "gateway.agents.cloudflare.com",
  "agw.ai.cfdata.org",
]);

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Health check (always allowed)
    if (url.pathname === "/health") {
      return Response.json({
        name: "macrodata",
        status: "ok",
        version: "0.1.0",
      });
    }

    // MCP endpoint
    if (url.pathname === "/mcp") {
      console.log("headers:", [...request.headers.entries()]);

      // This can't be faked by end users, only Cloudflare sets this header
      const cfWorker = request.headers.get("cf-worker");
      console.log(`[AUTH] cf-worker header: ${cfWorker}`);
      // Allow requests from Cloudflare's AI gateway (MCP portal)
      const isFromPortal = cfWorker && allowedWorkers.has(cfWorker);

      if (isFromPortal) {
        console.log(
          `[AUTH] Request from Cloudflare portal (${cfWorker}), allowing`,
        );
      } else {
        // Validate Cloudflare Access JWT for direct requests
        const auth = await validateAccessJWT(request, env);

        if (!auth.authenticated) {
          console.log(`[AUTH] Rejecting direct request - not authenticated`);
          return unauthorizedResponse(auth.error ?? "Unauthorized");
        }

        if (auth.user) {
          console.log(`[AUTH] Request from: ${auth.user.email}`);
        }
      }

      return MemoryAgent.serve("/mcp").fetch(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};
