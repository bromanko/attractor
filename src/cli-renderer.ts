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
      // marked-terminal can emit very loose spacing (especially for nested
      // lists and LLM-generated markdown). Collapse 3+ blank lines so review
      // prompts stay readable in the terminal.
      return rendered.replace(/\n{3,}/g, "\n\n").trimEnd();
    }
    return text;
  } catch (_err) {
    // Markdown rendering failed — return raw text as fallback
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

  isRunning(): boolean {
    return this._interval !== null;
  }

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
  status: "success" | "fail" | "cancelled";
  completedNodes: string[];
  logsRoot: string;
  elapsedMs: number;
  usageSummary?: RunUsageSummary;
}): string {
  const elapsed = formatDuration(opts.elapsedMs);
  const statusIcon = opts.status === "success"
    ? `${ANSI.green}✔ success${ANSI.reset}`
    : opts.status === "cancelled"
    ? `${ANSI.yellow}⊘ cancelled${ANSI.reset}`
    : `${ANSI.red}✘ fail${ANSI.reset}`;

  const path = opts.completedNodes.join(` ${ANSI.dim}→${ANSI.reset} `);

  const lines = [
    "",
    `  Status: ${statusIcon}`,
    `  Time:   ${ANSI.dim}${elapsed}${ANSI.reset}`,
    `  Path:   ${path}`,
    `  Logs:   ${ANSI.dim}${opts.logsRoot}${ANSI.reset}`,
  ];

  // Always append usage section
  if (opts.usageSummary) {
    lines.push(renderUsageSummary(opts.usageSummary));
  } else {
    // Render empty usage section for stable output
    lines.push(renderUsageSummary({ stages: [], totals: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 0, cost: 0 } }));
  }

  return lines.join("\n");
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
 * Render a pipeline failure summary block for the end-of-run output.
 */
export function renderFailureSummary(summary: {
  failedNode: string;
  failureClass: string;
  digest: string;
  firstFailingCheck?: string;
  rerunCommand?: string;
  logsPath?: string;
  failureReason?: string;
}): string {
  const lines = [
    "",
    `  ${ANSI.red}${ANSI.bold}Failure Summary${ANSI.reset}`,
    `  ${ANSI.dim}${"─".repeat(40)}${ANSI.reset}`,
    `  Node:     ${ANSI.bold}${summary.failedNode}${ANSI.reset}`,
    `  Class:    ${summary.failureClass}`,
    `  Error:    ${summary.digest}`,
  ];

  if (summary.firstFailingCheck) {
    lines.push(`  Check:    ${summary.firstFailingCheck}`);
  }
  if (summary.failureReason && summary.failureReason !== summary.digest) {
    lines.push(`  Reason:   ${ANSI.dim}${summary.failureReason}${ANSI.reset}`);
  }
  if (summary.rerunCommand) {
    lines.push(`  Rerun:    ${ANSI.dim}${summary.rerunCommand}${ANSI.reset}`);
  }
  if (summary.logsPath) {
    lines.push(`  Logs:     ${ANSI.dim}${summary.logsPath}${ANSI.reset}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Usage summary rendering
// ---------------------------------------------------------------------------

import type { RunUsageSummary, UsageMetrics } from "./pipeline/types.js";

/**
 * Format a cost value with adaptive precision.
 * - >= $1.00 → 2 decimal places
 * - >= $0.01 → 3 decimal places
 * - >= $0.001 → 4 decimal places
 * - < $0.001 → 6 decimal places
 */
export function formatCost(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.01) return `$${cost.toFixed(3)}`;
  if (cost >= 0.001) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(6)}`;
}

/**
 * Format a token count for display. Returns "—" for zero/missing.
 */
function formatTokens(count: number | undefined): string {
  if (count == null || count === 0) return "—";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

/**
 * Render the usage summary section. Always printed when usage data exists.
 * Includes per-stage/attempt breakdown and totals row.
 */
export function renderUsageSummary(summary: RunUsageSummary): string {
  const lines: string[] = [];

  lines.push("");
  lines.push(`  ${ANSI.bold}Usage${ANSI.reset}`);
  lines.push(`  ${ANSI.dim}${"─".repeat(40)}${ANSI.reset}`);

  // Column headers
  const hdr = (s: string, w: number) => s.padEnd(w);
  const rpad = (s: string, w: number) => s.padStart(w);

  lines.push(
    `  ${hdr("Stage", 22)} ${rpad("Input", 8)} ${rpad("Output", 8)} ${rpad("Cache R", 8)} ${rpad("Total", 8)} ${rpad("Cost", 10)}`,
  );
  lines.push(`  ${ANSI.dim}${"─".repeat(68)}${ANSI.reset}`);

  // Per-stage rows
  for (const s of summary.stages) {
    const label = s.attempt > 1
      ? `${s.stageId} #${s.attempt}`
      : s.stageId;
    const truncLabel = label.length > 21 ? label.slice(0, 20) + "…" : label;
    lines.push(
      `  ${ANSI.dim}${hdr(truncLabel, 22)} ${rpad(formatTokens(s.metrics.input_tokens), 8)} ${rpad(formatTokens(s.metrics.output_tokens), 8)} ${rpad(formatTokens(s.metrics.cache_read_tokens), 8)} ${rpad(formatTokens(s.metrics.total_tokens), 8)} ${rpad(formatCost(s.metrics.cost), 10)}${ANSI.reset}`,
    );
  }

  // Totals row
  lines.push(`  ${ANSI.dim}${"─".repeat(68)}${ANSI.reset}`);
  const t = summary.totals;
  lines.push(
    `  ${ANSI.bold}${hdr("Total", 22)} ${rpad(formatTokens(t.input_tokens), 8)} ${rpad(formatTokens(t.output_tokens), 8)} ${rpad(formatTokens(t.cache_read_tokens), 8)} ${rpad(formatTokens(t.total_tokens), 8)} ${rpad(formatCost(t.cost), 10)}${ANSI.reset}`,
  );

  return lines.join("\n");
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
