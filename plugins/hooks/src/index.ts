/**
 * OpenCode Plugin Hooks for Innie
 *
 * Provides:
 * - file.edited: Index state file changes for semantic search
 * - experimental.session.compacting: Preserve critical state during compaction
 *
 * These hooks use the memory package directly rather than calling MCP tools,
 * which is more efficient since they run in the same process.
 */

import type { Plugin } from "@opencode-ai/plugin";
import { readFile } from "node:fs/promises";
import { basename, relative } from "node:path";
import { indexFile, type MemoryItemType } from "@innie/memory/indexer";

// Files critical for compaction context (always preserve)
const COMPACTION_CRITICAL_FILES = [
  "state/today.md",
  "state/inbox.md",
  "state/commitments.md",
];

// Patterns for content type detection
const PEOPLE_PATTERN = /^state\/people\/.*\.md$/;
const PROJECT_PATTERN = /^state\/projects\/.*\.md$/;
const MEETING_PATTERN = /^state\/meetings\/.*\.md$/;

/**
 * Determine the memory type for a file path
 */
function getMemoryType(filePath: string): MemoryItemType | null {
  const rel = filePath.startsWith("state/")
    ? filePath
    : relative(process.cwd(), filePath);

  if (!rel.startsWith("state/")) return null;
  if (!rel.endsWith(".md")) return null;

  if (PEOPLE_PATTERN.test(rel)) return "person";
  if (PROJECT_PATTERN.test(rel)) return "project";
  if (MEETING_PATTERN.test(rel)) return "meeting";
  return "state";
}

export const InnieHooksPlugin: Plugin = async (_ctx) => {
  return {
    /**
     * file.edited hook: Index modified state files for semantic search
     *
     * When state files are edited, update the memory index so semantic
     * search stays current. This happens automatically - no tool call needed.
     */
    "file.edited": async (input) => {
      const { path: filePath, content } = input;

      // Determine if this is a file we should index
      const memoryType = getMemoryType(filePath);
      if (!memoryType) return;

      // Don't index empty files
      if (!content?.trim()) return;

      console.error(
        `[Hooks] Indexing ${memoryType} file: ${basename(filePath)}`
      );

      try {
        // Index directly - no MCP call needed
        const result = await indexFile(filePath, content, memoryType);
        console.error(
          `[Hooks] Indexed ${result.itemCount} sections from ${basename(filePath)}`
        );
      } catch (error) {
        // Don't fail the edit if indexing fails
        console.error(
          `[Hooks] Failed to index ${filePath}:`,
          error instanceof Error ? error.message : error
        );
      }
    },

    /**
     * experimental.session.compacting hook: Preserve state during compaction
     *
     * When OpenCode compacts the context (at ~90% capacity), this hook:
     * 1. Injects the critical state files so they survive compaction
     * 2. Instructs the model to save the conversation summary using log_journal
     *
     * Without this, the agent would lose track of today/inbox/commitments.
     */
    "experimental.session.compacting": async (_input, output) => {
      console.error("[Hooks] Preserving state during compaction");

      const stateContext: string[] = [];

      // Read each critical file
      for (const filePath of COMPACTION_CRITICAL_FILES) {
        try {
          const content = await readFile(filePath, "utf-8");
          if (content.trim()) {
            const name = basename(filePath, ".md");
            stateContext.push(`### ${name}\n${content}`);
          }
        } catch {
          // File might not exist yet
        }
      }

      // Build the compaction context with instruction
      const contextParts: string[] = [];

      // Add state files
      if (stateContext.length > 0) {
        contextParts.push(`## Critical State (preserved across compaction)

${stateContext.join("\n\n")}`);
        console.error(
          `[Hooks] Injected ${stateContext.length} state files into compaction context`
        );
      }

      // Add instruction to save summary
      contextParts.push(`## Post-Compaction Task

**IMPORTANT:** After this compaction completes, use the \`log_journal\` tool to save a summary of what was discussed and accomplished in this session. Include:
- Key decisions made
- Tasks completed or started
- Important context that should be remembered
- Any open threads to follow up on

This ensures continuity across context compactions.`);

      output.context.push(contextParts.join("\n\n"));
    },
  };
};

export default InnieHooksPlugin;
