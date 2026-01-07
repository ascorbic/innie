/**
 * OpenCode Plugin Hooks for Innie
 *
 * Provides:
 * - file.edited: Index state file changes for semantic search + git autocommit
 * - experimental.session.compacting: Preserve critical state during compaction
 *
 * These hooks use the memory package directly rather than calling MCP tools,
 * which is more efficient since they run in the same process.
 */

import type { Plugin } from "@opencode-ai/plugin";
import { basename, relative } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { indexFile, type MemoryItemType } from "@innie-ai/memory/indexer";

const execAsync = promisify(exec);

// Patterns for content type detection
const PEOPLE_PATTERN = /^state\/people\/.*\.md$/;
const PROJECT_PATTERN = /^state\/projects\/.*\.md$/;
const MEETING_PATTERN = /^state\/meetings\/.*\.md$/;

// Debounce git commits - collect changes over 2 seconds
let commitTimeout: ReturnType<typeof setTimeout> | null = null;
const pendingFiles: Set<string> = new Set();

/**
 * Queue a file for git commit, debounced to batch rapid changes
 */
async function queueGitCommit(filePath: string, memoryDir: string) {
  pendingFiles.add(basename(filePath));

  if (commitTimeout) {
    clearTimeout(commitTimeout);
  }

  commitTimeout = setTimeout(async () => {
    const files = Array.from(pendingFiles);
    pendingFiles.clear();
    commitTimeout = null;

    try {
      // Stage and commit state changes
      await execAsync("git add -A", { cwd: memoryDir });

      // Check if there are staged changes
      const { stdout: status } = await execAsync(
        "git diff --cached --name-only",
        { cwd: memoryDir }
      );
      if (!status.trim()) return;

      const message =
        files.length === 1
          ? `Update ${files[0]}`
          : `Update ${files.length} files: ${files.slice(0, 3).join(", ")}${files.length > 3 ? "..." : ""}`;

      await execAsync(`git commit -m "${message}"`, { cwd: memoryDir });
      console.error(`[Hooks] Committed: ${message}`);
    } catch (error) {
      // Git errors are non-fatal
      console.error(
        `[Hooks] Git commit failed:`,
        error instanceof Error ? error.message : error
      );
    }
  }, 2000);
}

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

      // Queue git commit for state changes
      const memoryDir = process.env.MEMORY_DIR;
      if (memoryDir) {
        queueGitCommit(filePath, memoryDir);
      }
    },

    /**
     * experimental.session.compacting hook: Trigger summary on compaction
     *
     * When OpenCode compacts the context (at ~90% capacity), this hook
     * instructs the model to save a conversation summary using log_journal.
     *
     * Note: State files (today, inbox, commitments) are already preserved
     * via the `instructions` array in opencode.json - they're part of the
     * system prompt which survives compaction.
     */
    "experimental.session.compacting": async (_input, output) => {
      console.error("[Hooks] Injecting post-compaction summary instruction");

      output.context.push(`## Post-Compaction Task

**IMPORTANT:** After this compaction completes, use the \`log_journal\` tool to save a summary of what was discussed and accomplished in this session. Include:
- Key decisions made
- Tasks completed or started
- Important context that should be remembered
- Any open threads to follow up on

This ensures continuity across context compactions.`);
    },
  };
};

export default InnieHooksPlugin;
