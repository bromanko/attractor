/**
 * CLI Renderer — Beautiful terminal output for Attractor pipelines.
 *
 * Provides:
 * - Box-drawing banner with correct alignment
 * - Spinner with elapsed timer for long-running stages
 * - Markdown rendering for LLM responses
 * - Per-stage model display
 */

import { marked } from "marked";
// @ts-ignore — marked-terminal has no type declarations
import { markedTerminal } from "marked-terminal";

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
  white: "\x1b[37m",
  bgCyan: "\x1b[46m",
  bgBlack: "\x1b[40m",
} as const;

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

// Configure marked with terminal renderer
marked.use(markedTerminal());

/**
 * Render a markdown string to ANSI-formatted terminal output.
 * Falls back to raw text if rendering fails.
 */
export function renderMarkdown(text: string): string {
  try {
    const rendered = marked.parse(text);
    if (typeof rendered === "string") {
      return rendered.trimEnd();
    }
    return text;
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

/**
 * Render the startup banner with consistent box-drawing alignment.
 * All rows have identical visible width regardless of content.
 */
export function renderBanner(opts: {
  goal: string;
  defaultModel: string;
  toolMode: string;
  nodeCount: number;
}): string {
  const innerWidth = 52;

  // Pad a plain-text string to exactly innerWidth visible characters.
  // Truncates with ellipsis if too long.
  const pad = (text: string): string => {
    const truncated = text.length > innerWidth
      ? text.slice(0, innerWidth - 1) + "…"
      : text;
    return truncated + " ".repeat(Math.max(0, innerWidth - truncated.length));
  };

  const top     = `┌${"─".repeat(innerWidth + 2)}┐`;
  const bottom  = `└${"─".repeat(innerWidth + 2)}┘`;
  const divider = `├${"─".repeat(innerWidth + 2)}┤`;

  // Build each content row: pad the visible text first, then wrap with
  // box-drawing characters and optional ANSI styling.
  const row = (visible: string) => `│ ${pad(visible)} │`;

  const goalText = opts.goal.slice(0, innerWidth);

  const lines = [
    "",
    `  ${top}`,
    `  │ ${pad("Attractor Pipeline")} │`,
    `  ${divider}`,
    `  │ ${pad(goalText)} │`,
    `  ${row("")}`,
    `  │ ${pad(`Default model: ${opts.defaultModel}`)} │`,
    `  │ ${pad(`Tools:         ${opts.toolMode}`)} │`,
    `  │ ${pad(`Nodes:         ${opts.nodeCount}`)} │`,
    `  ${bottom}`,
    "",
  ];

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * A terminal spinner with elapsed time display.
 * Writes to stdout using ANSI cursor control for in-place updates.
 */
export class Spinner {
  private _frame = 0;
  private _interval: ReturnType<typeof setInterval> | null = null;
  private _startTime = 0;
  private _message = "";
  private _model: string | undefined;

  /**
   * Start spinning with the given stage message.
   * @param message  Stage name to display
   * @param model    Optional model override to show (only non-default)
   */
  start(message: string, model?: string): void {
    this._message = message;
    this._model = model;
    this._startTime = Date.now();
    this._frame = 0;

    // Write initial line
    this._render();

    this._interval = setInterval(() => {
      this._frame = (this._frame + 1) % SPINNER_FRAMES.length;
      this._render();
    }, 80);
  }

  private _render(): void {
    const elapsed = this._formatElapsed();
    const spinner = SPINNER_FRAMES[this._frame];
    const modelTag = this._model ? ` ${ANSI.dim}[${this._model}]${ANSI.reset}` : "";

    // Clear line and write spinner
    process.stdout.write(
      `\r  ${ANSI.cyan}${spinner}${ANSI.reset} ${this._message}${modelTag} ${ANSI.dim}${elapsed}${ANSI.reset}`,
    );
  }

  private _formatElapsed(): string {
    const ms = Date.now() - this._startTime;
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    const remainSecs = secs % 60;
    return `${mins}m${remainSecs.toString().padStart(2, "0")}s`;
  }

  /**
   * Stop the spinner and write the completion status.
   * @param status  "success" | "fail" | other
   * @param detail  Optional detail (error message, etc.)
   */
  stop(status: "success" | "fail" | string, detail?: string): void {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }

    const elapsed = this._formatElapsed();
    const modelTag = this._model ? ` ${ANSI.dim}[${this._model}]${ANSI.reset}` : "";

    // Clear the spinner line
    process.stdout.write("\r\x1b[K");

    if (status === "success") {
      process.stdout.write(
        `  ${ANSI.green}✔${ANSI.reset} ${this._message}${modelTag} ${ANSI.dim}${elapsed}${ANSI.reset}\n`,
      );
    } else if (status === "fail") {
      const reason = detail ? ` ${ANSI.dim}— ${detail}${ANSI.reset}` : "";
      process.stdout.write(
        `  ${ANSI.red}✘${ANSI.reset} ${this._message}${modelTag} ${ANSI.dim}${elapsed}${ANSI.reset}${reason}\n`,
      );
    } else {
      process.stdout.write(
        `  ${ANSI.yellow}○${ANSI.reset} ${this._message}${modelTag} ${ANSI.dim}${elapsed}${ANSI.reset}\n`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Event formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format a pipeline completion summary.
 */
export function renderSummary(opts: {
  status: "success" | "fail";
  completedNodes: string[];
  logsRoot: string;
  elapsedMs: number;
}): string {
  const elapsed = formatDuration(opts.elapsedMs);
  const statusIcon = opts.status === "success"
    ? `${ANSI.green}✔ success${ANSI.reset}`
    : `${ANSI.red}✘ fail${ANSI.reset}`;

  const path = opts.completedNodes.join(` ${ANSI.dim}→${ANSI.reset} `);

  return [
    "",
    `  Status: ${statusIcon}`,
    `  Time:   ${ANSI.dim}${elapsed}${ANSI.reset}`,
    `  Path:   ${path}`,
    `  Logs:   ${ANSI.dim}${opts.logsRoot}${ANSI.reset}`,
  ].join("\n");
}

/**
 * Format a resume info block.
 */
export function renderResumeInfo(checkpoint: { current_node: string; completed_nodes: string[] }, resumeAt: string): string {
  return [
    `  ${ANSI.yellow}♻${ANSI.reset}  Resuming from: ${ANSI.bold}${resumeAt}${ANSI.reset}`,
    `  ${ANSI.dim}✓  Previously completed: ${checkpoint.completed_nodes.join(" → ")}${ANSI.reset}`,
    "",
  ].join("\n");
}

/**
 * Format milliseconds into a human-readable duration.
 */
export function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  if (mins < 60) return `${mins}m ${remainSecs}s`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hours}h ${remainMins}m ${remainSecs}s`;
}
