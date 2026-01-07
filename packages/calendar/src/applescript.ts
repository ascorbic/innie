/**
 * AppleScript helpers for Calendar.app
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * Run an AppleScript and return the result
 */
export async function runAppleScript(script: string): Promise<string> {
  const { stdout } = await execAsync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
    timeout: 30000,
  });
  return stdout.trim();
}

/**
 * Run a multi-line AppleScript
 */
export async function runAppleScriptFile(script: string): Promise<string> {
  // Use heredoc style for complex scripts
  const { stdout } = await execAsync(`osascript <<'APPLESCRIPT'
${script}
APPLESCRIPT`, {
    timeout: 30000,
  });
  return stdout.trim();
}

/**
 * Parse AppleScript list output into array
 * AppleScript returns lists like: item1, item2, item3
 */
export function parseAppleScriptList(output: string): string[] {
  if (!output || output === "missing value") return [];
  return output.split(", ").map(s => s.trim()).filter(Boolean);
}

/**
 * Parse AppleScript date to ISO string
 * AppleScript dates look like: "Wednesday, 7 January 2026 at 10:00:00"
 */
export function parseAppleScriptDate(dateStr: string): string | null {
  if (!dateStr || dateStr === "missing value") return null;
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return null;
    return date.toISOString();
  } catch {
    return null;
  }
}

/**
 * Format JS Date for AppleScript
 */
export function formatDateForAppleScript(date: Date): string {
  // AppleScript can parse ISO dates
  return date.toISOString();
}
