#!/usr/bin/env node
/**
 * Memory MCP Server for Innie
 *
 * Provides:
 * - Journal logging for agent observations
 * - Conversation summaries for context recovery
 * - Semantic search over state files, journal, projects, people
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  logJournal,
  getRecentJournalEntries,
  formatJournalForContext,
  saveConversationSummary,
  getRecentSummaries,
} from "./journal.js";
import {
  searchMemory,
  rebuildIndex,
  getIndexStats,
  indexJournalEntry,
  indexFile,
  getEntryWithRelated,
  type MemoryItemType,
} from "./indexer.js";
import {
  addCronReminder,
  addOnceReminder,
  removeReminder,
  listReminders,
} from "./scheduler.js";

const server = new Server(
  {
    name: "innie-memory",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Tool definitions
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "log_journal",
      description:
        "Write a journal entry. Use this to record observations, decisions, or things to remember.",
      inputSchema: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: "Short topic/category for the entry",
          },
          content: {
            type: "string",
            description: "The journal entry content",
          },
          agentIntent: {
            type: "string",
            description: "Optional: why you're logging this",
          },
        },
        required: ["topic", "content"],
      },
    },
    {
      name: "get_recent_journal",
      description: "Retrieve recent journal entries for context",
      inputSchema: {
        type: "object",
        properties: {
          count: {
            type: "number",
            description: "Number of entries to retrieve (default: 40)",
            default: 40,
          },
        },
      },
    },
    {
      name: "save_conversation_summary",
      description:
        "Save a summary of the current conversation for context recovery in future sessions",
      inputSchema: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "Brief summary of what was discussed/accomplished",
          },
          notes: {
            type: "string",
            description:
              "Freeform notes for anything that doesn't fit structured fields",
          },
          keyDecisions: {
            type: "array",
            items: { type: "string" },
            description: "Important decisions made",
          },
          openThreads: {
            type: "array",
            items: { type: "string" },
            description: "Topics to follow up on",
          },
          learnedPatterns: {
            type: "array",
            items: { type: "string" },
            description: "New patterns learned about the user",
          },
        },
        required: ["summary"],
      },
    },
    {
      name: "get_recent_summaries",
      description: "Get recent conversation summaries for context recovery",
      inputSchema: {
        type: "object",
        properties: {
          count: {
            type: "number",
            description: "Number of summaries to retrieve (default: 7)",
            default: 7,
          },
        },
      },
    },
    {
      name: "search_memory",
      description:
        "Semantic search over your history - journal, state files, projects, people. Use to find relevant context.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural language query to search for",
          },
          limit: {
            type: "number",
            description: "Maximum results to return (default: 5)",
            default: 5,
          },
          type: {
            type: "string",
            enum: ["journal", "state", "project", "person", "meeting", "topic"],
            description: "Filter by content type",
          },
          since: {
            type: "string",
            description: "Only include items after this ISO date",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "rebuild_memory_index",
      description:
        "Rebuild the semantic search index from scratch. Use if index seems stale or corrupted.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_memory_index_stats",
      description: "Get statistics about the memory index",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "index_file",
      description:
        "Index a file for semantic search. Called by hooks when state files change.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path",
          },
          content: {
            type: "string",
            description: "File content",
          },
          type: {
            type: "string",
            enum: ["state", "project", "person", "meeting", "topic"],
            description: "Content type",
          },
        },
        required: ["path", "content", "type"],
      },
    },
    {
      name: "get_related",
      description:
        "Get entries related to a specific memory item. Useful for exploring associative connections in your memory.",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description:
              "The ID of the memory item to find related entries for",
          },
        },
        required: ["id"],
      },
    },
    // Scheduling tools
    {
      name: "schedule_reminder",
      description:
        "Schedule a recurring reminder using cron syntax. Examples: '0 9 * * *' = 9am daily, '0 */2 * * *' = every 2 hours. IMPORTANT: Check the current time before using this tool to ensure accurate scheduling.",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Unique reminder identifier",
          },
          cronExpression: {
            type: "string",
            description: "Cron expression (e.g., '0 9 * * *' for 9am daily)",
          },
          description: {
            type: "string",
            description: "What this reminder is for",
          },
          payload: {
            type: "string",
            description: "Message to process when reminder fires",
          },
          model: {
            type: "string",
            description:
              "Model to use (e.g., 'anthropic/claude-opus-4-5' for deep thinking tasks)",
          },
        },
        required: ["id", "cronExpression", "description", "payload"],
      },
    },
    {
      name: "schedule_once",
      description:
        "Schedule a one-shot reminder at a specific date/time. The reminder fires once and is automatically removed. IMPORTANT: Check the current time before using this tool to ensure accurate scheduling.",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Unique reminder identifier",
          },
          datetime: {
            type: "string",
            description: "ISO 8601 datetime (e.g., '2026-01-06T10:00:00')",
          },
          description: {
            type: "string",
            description: "What this reminder is for",
          },
          payload: {
            type: "string",
            description: "Message to process when reminder fires",
          },
          model: {
            type: "string",
            description:
              "Model to use (e.g., 'anthropic/claude-opus-4-5' for deep thinking tasks)",
          },
        },
        required: ["id", "datetime", "description", "payload"],
      },
    },
    {
      name: "remove_reminder",
      description: "Remove a scheduled reminder",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Reminder ID to remove",
          },
        },
        required: ["id"],
      },
    },
    {
      name: "list_reminders",
      description: "List all scheduled reminders",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
}));

// Tool implementations
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "log_journal": {
        const { topic, content, agentIntent } = args as {
          topic: string;
          content: string;
          agentIntent?: string;
        };
        await logJournal({ topic, content, agentIntent });

        // Also index the entry for search
        await indexJournalEntry({
          timestamp: new Date().toISOString(),
          topic,
          content,
          agentIntent,
        });

        return {
          content: [{ type: "text", text: "Journal entry logged" }],
        };
      }

      case "get_recent_journal": {
        const count = (args as { count?: number }).count ?? 40;
        const entries = await getRecentJournalEntries(count);
        const formatted = formatJournalForContext(entries);
        return {
          content: [{ type: "text", text: formatted }],
        };
      }

      case "save_conversation_summary": {
        const { summary, notes, keyDecisions, openThreads, learnedPatterns } =
          args as {
            summary: string;
            notes?: string;
            keyDecisions?: string[];
            openThreads?: string[];
            learnedPatterns?: string[];
          };
        const today = new Date().toISOString().split("T")[0];
        await saveConversationSummary({
          date: today,
          summary,
          notes,
          keyDecisions,
          openThreads,
          learnedPatterns,
        });
        return {
          content: [
            { type: "text", text: `Conversation summary saved for ${today}` },
          ],
        };
      }

      case "get_recent_summaries": {
        const count = (args as { count?: number }).count ?? 7;
        const summaries = await getRecentSummaries(count);
        if (summaries.length === 0) {
          return {
            content: [
              { type: "text", text: "(no conversation summaries yet)" },
            ],
          };
        }
        const formatted = summaries
          .map((s) => {
            const parts = [`**${s.date}**: ${s.summary}`];
            if (s.notes) parts.push(`  Notes: ${s.notes}`);
            if (s.keyDecisions?.length)
              parts.push(`  Decisions: ${s.keyDecisions.join(", ")}`);
            if (s.openThreads?.length)
              parts.push(`  Open: ${s.openThreads.join(", ")}`);
            if (s.learnedPatterns?.length)
              parts.push(`  Patterns: ${s.learnedPatterns.join(", ")}`);
            return parts.join("\n");
          })
          .join("\n\n");
        return {
          content: [{ type: "text", text: formatted }],
        };
      }

      case "search_memory": {
        const { query, limit, type, since } = args as {
          query: string;
          limit?: number;
          type?: MemoryItemType;
          since?: string;
        };
        const results = await searchMemory(query, { limit, type, since });

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: "(no matches found)" }],
          };
        }

        // Helper to extract title from topic content (first # heading)
        const extractTitle = (content: string): string | null => {
          const match = content.match(/^#\s+(.+)$/m);
          return match ? match[1] : null;
        };

        // Helper to get filename without extension from path
        const getFilename = (path: string): string => {
          const parts = path.split("/");
          const file = parts[parts.length - 1] || path;
          return file.replace(/\.md$/, "");
        };

        const formatted = results
          .map((r, i) => {
            const header = `[${i + 1}] ${r.type}${r.section ? ` / ${r.section}` : ""} (score: ${r.score.toFixed(3)})`;
            const meta = r.timestamp ? `  Date: ${r.timestamp}` : "";
            const source = `  Source: ${r.source}`;
            const content =
              r.type === "topic"
                ? r.content
                : r.content.slice(0, 500) +
                  (r.content.length > 500 ? "..." : "");

            // Format related items as compact hints
            // For topics, show "filename: Title" format
            const relatedLine = r.related?.length
              ? `  Related: ${r.related
                  .map((rel) => {
                    if (rel.type === "topic") {
                      const filename = getFilename(rel.source);
                      const title =
                        extractTitle(rel.snippet) || rel.snippet.slice(0, 30);
                      return `"${filename}": ${title}`;
                    }
                    return `[${rel.type}] ${rel.snippet.slice(0, 40)}...`;
                  })
                  .join(" | ")}`
              : "";

            return [header, meta, source, "", content, relatedLine]
              .filter(Boolean)
              .join("\n");
          })
          .join("\n\n---\n\n");

        return {
          content: [{ type: "text", text: formatted }],
        };
      }

      case "rebuild_memory_index": {
        const result = await rebuildIndex();
        return {
          content: [
            {
              type: "text",
              text: `Index rebuilt successfully. Indexed ${result.itemCount} items.`,
            },
          ],
        };
      }

      case "get_memory_index_stats": {
        const stats = await getIndexStats();
        return {
          content: [
            {
              type: "text",
              text: `Index contains ${stats.itemCount} items.`,
            },
          ],
        };
      }

      case "index_file": {
        const { path, content, type } = args as {
          path: string;
          content: string;
          type: "state" | "project" | "person" | "meeting" | "topic";
        };
        const result = await indexFile(path, content, type);
        return {
          content: [
            {
              type: "text",
              text: `Indexed ${result.itemCount} sections from ${path}`,
            },
          ],
        };
      }

      case "get_related": {
        const { id } = args as { id: string };
        const { entry, related } = await getEntryWithRelated(id);

        if (!entry) {
          return {
            content: [{ type: "text", text: `Entry "${id}" not found` }],
            isError: true,
          };
        }

        const parts: string[] = [];

        // Format the main entry
        parts.push("**Entry:**");
        parts.push(
          `  ${entry.timestamp || "no date"} - ${entry.content.slice(0, 200)}...`,
        );

        // Format related entries
        if (related.length > 0) {
          parts.push("");
          parts.push(`**Related (${related.length}):**`);
          for (const r of related) {
            parts.push(`  - [${r.type}] ${r.snippet} (${r.score.toFixed(2)})`);
          }
        } else {
          parts.push("");
          parts.push("(no related entries found)");
        }

        return {
          content: [{ type: "text", text: parts.join("\n") }],
        };
      }

      // Scheduling tools
      case "schedule_reminder": {
        const { id, cronExpression, description, payload, model } = args as {
          id: string;
          cronExpression: string;
          description: string;
          payload: string;
          model?: string;
        };
        const reminder = await addCronReminder(
          id,
          cronExpression,
          description,
          payload,
          model,
        );
        const modelInfo = model ? ` (model: ${model})` : "";
        return {
          content: [
            {
              type: "text",
              text: `Reminder scheduled: "${description}" (${cronExpression})${modelInfo}`,
            },
          ],
        };
      }

      case "schedule_once": {
        const { id, datetime, description, payload, model } = args as {
          id: string;
          datetime: string;
          description: string;
          payload: string;
          model?: string;
        };
        const reminder = await addOnceReminder(
          id,
          datetime,
          description,
          payload,
          model,
        );
        const date = new Date(datetime);
        const modelInfo = model ? ` (model: ${model})` : "";
        return {
          content: [
            {
              type: "text",
              text: `One-time reminder scheduled: "${description}" at ${date.toLocaleString("en-GB")}${modelInfo}`,
            },
          ],
        };
      }

      case "remove_reminder": {
        const { id } = args as { id: string };
        const removed = await removeReminder(id);
        return {
          content: [
            {
              type: "text",
              text: removed
                ? `Reminder "${id}" removed`
                : `Reminder "${id}" not found`,
            },
          ],
        };
      }

      case "list_reminders": {
        const reminders = await listReminders();
        if (reminders.length === 0) {
          return {
            content: [{ type: "text", text: "(no scheduled reminders)" }],
          };
        }
        const formatted = reminders
          .map((r) => {
            const scheduleInfo =
              r.type === "cron"
                ? `Cron: ${r.schedule}`
                : `Once: ${new Date(r.schedule).toLocaleString("en-GB")}`;
            const lastRun = r.lastRun
              ? `Last run: ${new Date(r.lastRun).toLocaleString("en-GB")}`
              : "Never run";
            return `**${r.id}**: ${r.description}\n  ${scheduleInfo} | ${lastRun}`;
          })
          .join("\n\n");
        return {
          content: [{ type: "text", text: formatted }],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[Memory] MCP server started");
}

main().catch((error) => {
  console.error("[Memory] Fatal error:", error);
  process.exit(1);
});
