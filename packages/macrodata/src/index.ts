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
import { createWorkersAI } from "workers-ai-provider";
import { searchWeb, searchNews } from "./web-search";
import { fetchPageAsMarkdown } from "./web-fetch";

// Embedding model: 768 dimensions
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

export class MemoryAgent extends McpAgent<Env> {
  // URLs allowed to be fetched (from search results or user input)
  private allowedUrls: Set<string> = new Set();

  server = new McpServer({
    name: "Macrodata",
    version: "0.1.0",
  });

  async init() {
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
        const id = `journal-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
        const text = `${topic}: ${content}`;

        const embedding = await this.getEmbedding(text);

        await this.env.VECTORIZE.upsert([
          {
            id,
            values: embedding,
            metadata: {
              type: "journal",
              topic,
              content,
              intent: intent ?? "",
              timestamp: new Date().toISOString(),
            },
          },
        ]);

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
        const embedding = await this.getEmbedding(query);
        const filter = type === "all" ? undefined : { type: { $eq: type } };

        const results = await this.env.VECTORIZE.query(embedding, {
          topK: limit,
          returnMetadata: "all",
          filter,
        });

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
      "Get your identity, current state, and recent context for session initialization. Call this at the start of each session.",
      {},
      async () => {
        const identityResults = await this.env.VECTORIZE.query(
          await this.getEmbedding("identity persona who am I"),
          {
            topK: 1,
            returnMetadata: "all",
            filter: { type: { $eq: "identity" } },
          },
        );

        const todayResults = await this.env.VECTORIZE.query(
          await this.getEmbedding("today focus priorities current"),
          {
            topK: 1,
            returnMetadata: "all",
            filter: { type: { $eq: "today" } },
          },
        );

        const recentResults = await this.env.VECTORIZE.query(
          await this.getEmbedding("recent activity what happened"),
          {
            topK: 5,
            returnMetadata: "all",
            filter: { type: { $eq: "journal" } },
          },
        );

        const identity =
          (identityResults.matches[0]?.metadata as Record<string, string>)
            ?.content ?? "No identity configured yet.";

        const today =
          (todayResults.matches[0]?.metadata as Record<string, string>)
            ?.content ?? "No focus set for today.";

        const recent = recentResults.matches
          .map((m) => {
            const meta = m.metadata as Record<string, string>;
            return `- [${meta.topic}] ${meta.content}`;
          })
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text: `## Identity\n${identity}\n\n## Today\n${today}\n\n## Recent Activity\n${recent || "No recent entries."}`,
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
        const id = `state-${type}-${name}`;
        const embedding = await this.getEmbedding(`${name}: ${content}`);

        await this.env.VECTORIZE.upsert([
          {
            id,
            values: embedding,
            metadata: {
              type,
              name,
              content,
              updatedAt: new Date().toISOString(),
            },
          },
        ]);

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
        const results = await this.env.VECTORIZE.getByIds([
          `state-${type}-${name}`,
        ]);

        if (results.length === 0) {
          return {
            content: [
              { type: "text", text: `State file not found: ${type}/${name}` },
            ],
          };
        }

        const meta = results[0].metadata as Record<string, string>;
        return {
          content: [
            { type: "text", text: `# ${meta.name}\n\n${meta.content}` },
          ],
        };
      },
    );

    this.server.tool(
      "list_topics",
      "List all topics (your distilled knowledge).",
      {},
      async () => {
        const results = await this.env.VECTORIZE.query(
          await this.getEmbedding("topic knowledge understanding"),
          {
            topK: 100,
            returnMetadata: "all",
            filter: { type: { $eq: "topic" } },
          },
        );

        if (results.matches.length === 0) {
          return { content: [{ type: "text", text: "No topics yet." }] };
        }

        const topics = results.matches
          .map((m) => `- ${(m.metadata as Record<string, string>).name}`)
          .join("\n");

        return { content: [{ type: "text", text: `## Topics\n\n${topics}` }] };
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
        const workersAI = createWorkersAI({ binding: this.env.AI });

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

        const { text } = await generateText({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          model: workersAI("@cf/meta/llama-3.1-8b-instruct" as any),
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
    // Scheduling Tool
    // ==========================================

    this.server.tool(
      "schedule_task",
      "Schedule a memory maintenance task to run in the future.",
      {
        delaySeconds: z.number().describe("Seconds from now to run the task"),
        task: z
          .enum(["consolidate", "reflect", "cleanup"])
          .describe("Task to run"),
        focus: z.string().optional().describe("Specific focus area"),
      },
      async ({ delaySeconds, task, focus }) => {
        await this.schedule(delaySeconds, "runScheduledTask", { task, focus });

        return {
          content: [
            {
              type: "text",
              text: `Scheduled "${task}" to run in ${delaySeconds} seconds`,
            },
          ],
        };
      },
    );
  }

  // ==========================================
  // Scheduled Task Handler
  // ==========================================

  async runScheduledTask(data: { task: string; focus?: string }) {
    console.log(`[SCHEDULED] Running task: ${data.task}`);

    const workersAI = createWorkersAI({ binding: this.env.AI });

    const context = await this.env.VECTORIZE.query(
      await this.getEmbedding(data.focus ?? data.task),
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

    const { text } = await generateText({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: workersAI("@cf/meta/llama-3.1-8b-instruct" as any),
      prompt: `Scheduled ${data.task} task. ${data.focus ? `Focus: ${data.focus}` : ""}\n\nContext:\n${contextText}\n\nPerform the ${data.task} operation and summarize what you did.`,
    });

    const id = `journal-scheduled-${Date.now()}`;
    await this.env.VECTORIZE.upsert([
      {
        id,
        values: await this.getEmbedding(`scheduled ${data.task}: ${text}`),
        metadata: {
          type: "journal",
          topic: `scheduled-${data.task}`,
          content: text,
          timestamp: new Date().toISOString(),
        },
      },
    ]);

    console.log(`[SCHEDULED] Task complete: ${data.task}`);
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
      console.log('headers:', [...request.headers.entries()]);

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
