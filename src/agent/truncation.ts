/**
 * Tool output truncation — Section 5 of the Coding Agent Loop Spec.
 * Character-based truncation first, then line-based.
 */

import type { SessionConfig } from "./types.js";

const DEFAULT_TRUNCATION_MODES: Record<string, "head_tail" | "tail"> = {
  read_file: "head_tail",
  shell: "head_tail",
  grep: "tail",
  glob: "tail",
  edit_file: "tail",
  apply_patch: "tail",
  write_file: "tail",
  spawn_agent: "head_tail",
};

/**
 * Character-based truncation with head/tail split.
 * Section 5.1.
 */
export function truncateChars(output: string, maxChars: number, mode: "head_tail" | "tail"): string {
  if (output.length <= maxChars) return output;

  if (mode === "head_tail") {
    const half = Math.floor(maxChars / 2);
    const removed = output.length - maxChars;
    return (
      output.slice(0, half) +
      `\n\n[WARNING: Tool output was truncated. ${removed} characters were removed from the middle. ` +
      `The full output is available in the event stream. ` +
      `If you need to see specific parts, re-run the tool with more targeted parameters.]\n\n` +
      output.slice(-half)
    );
  }

  // tail mode
  const removed = output.length - maxChars;
  return (
    `[WARNING: Tool output was truncated. First ${removed} characters were removed. ` +
    `The full output is available in the event stream.]\n\n` +
    output.slice(-maxChars)
  );
}

/**
 * Line-based truncation with head/tail split.
 */
export function truncateLines(output: string, maxLines: number): string {
  const lines = output.split("\n");
  if (lines.length <= maxLines) return output;

  const headCount = Math.floor(maxLines / 2);
  const tailCount = maxLines - headCount;
  const omitted = lines.length - headCount - tailCount;

  return (
    lines.slice(0, headCount).join("\n") +
    `\n[... ${omitted} lines omitted ...]\n` +
    lines.slice(-tailCount).join("\n")
  );
}

/**
 * Full truncation pipeline: char-based first, then line-based.
 * Section 5.3.
 */
export function truncateToolOutput(
  output: string,
  toolName: string,
  config: SessionConfig,
): string {
  const maxChars = config.tool_output_limits[toolName] ?? 30_000;
  const mode = DEFAULT_TRUNCATION_MODES[toolName] ?? "head_tail";

  // Step 1: Character-based
  let result = truncateChars(output, maxChars, mode);

  // Step 2: Line-based
  const maxLines = config.tool_line_limits[toolName];
  if (maxLines != null) {
    result = truncateLines(result, maxLines);
  }

  return result;
}
