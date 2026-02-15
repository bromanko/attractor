/**
 * attractor-panel.ts — TUI panel for Attractor pipeline execution.
 *
 * Uses pi's ctx.ui to show:
 *  - Status bar: attractor label, progress counter, spinner, current stage
 *  - Bracket messages: "Starting [stage]..." / "✔ [stage] (elapsed)" in the
 *    conversation area. Actual LLM output streams natively through pi's agent.
 */

import type { PipelineEvent } from "../pipeline/types.js";
import type { PipelineResult } from "../pipeline/engine.js";
import type { RunUsageSummary } from "../pipeline/types.js";

// ---------------------------------------------------------------------------
// Minimal UI surface (subset of ExtensionUIContext / ExtensionContext)
// ---------------------------------------------------------------------------

/** Message payload for rendering stage results in the conversation area. */
export interface StageMessage {
  customType: string;
  content: string;
  display: boolean;
  details: StageMessageDetails;
}

export interface StageMessageDetails {
  stage: string;
  state: "success" | "fail" | "started";
  elapsed?: string;
  output?: string;
  error?: string;
  toolFailure?: Record<string, unknown>;
}

export interface PanelUI {
  setStatus(key: string, text: string | undefined): void;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  /** Send a styled message to the conversation area. */
  sendMessage(message: { customType: string; content: string; display: boolean; details: StageMessageDetails }): void;
}

export interface PanelTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
  strikethrough(text: string): string;
}

// ---------------------------------------------------------------------------
// Stage tracking
// ---------------------------------------------------------------------------

type StageState = "pending" | "running" | "success" | "fail" | "retry" | "cancelled";

interface StageEntry {
  name: string;
  state: StageState;
  error?: string;
  startedAt?: number;
  completedAt?: number;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

const STATUS_KEY = "attractor";
const LABEL = "attractor";
export const CUSTOM_MESSAGE_TYPE = "attractor-stage";

/** Max chars of output to include in a stage-completed notification. */
const OUTPUT_PREVIEW_LIMIT = 500;

export class AttractorPanel {
  private _ui: PanelUI;
  private _theme: PanelTheme;
  private _stages: StageEntry[] = [];
  private _pipelineRunning = false;
  private _lastUsage: RunUsageSummary | undefined;
  private _totalNodes = 0;

  constructor(ui: PanelUI, theme: PanelTheme) {
    this._ui = ui;
    this._theme = theme;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Feed a pipeline event into the panel for rendering. */
  handleEvent(event: PipelineEvent): void {
    const d = event.data as Record<string, unknown>;

    switch (event.kind) {
      case "pipeline_started":
        this._pipelineRunning = true;
        this._totalNodes = typeof d.nodeCount === "number" ? d.nodeCount : 0;
        this._status("running", "warning");
        break;

      case "pipeline_resumed":
        this._pipelineRunning = true;
        this._totalNodes = typeof d.nodeCount === "number" ? d.nodeCount : 0;
        this._status(`resuming at ${d.from}`, "warning");
        break;

      case "stage_started": {
        const name = String(d.name);
        this._stages.push({ name, state: "running", startedAt: Date.now() });
        this._status(name, "warning");
        this._sendStageStarted(name);
        break;
      }

      case "stage_completed": {
        const name = String(d.name);
        const entry = this._findStage(name);
        if (entry) {
          entry.state = "success";
          entry.completedAt = Date.now();
        }
        this._sendStageCompleted(name, d, entry);
        break;
      }

      case "stage_failed": {
        const name = String(d.name);
        const entry = this._findStage(name);
        if (entry) {
          entry.state = "fail";
          entry.error = d.error ? String(d.error) : undefined;
          entry.completedAt = Date.now();
        }
        this._sendStageFailure(name, d, entry);
        break;
      }

      case "stage_retrying": {
        const name = String(d.name);
        const entry = this._findStage(name);
        if (entry) entry.state = "retry";
        this._status(`${name} — retrying`, "warning");
        break;
      }

      case "pipeline_completed":
        this._pipelineRunning = false;
        this._status("completed", "success");
        break;

      case "pipeline_failed": {
        this._pipelineRunning = false;
        this._status("failed", "error");
        if (d.error) {
          this._ui.notify(
            `${this._theme.fg("error", "✘ Pipeline failed:")} ${d.error}`,
            "error",
          );
        }
        break;
      }

      case "pipeline_cancelled":
        this._pipelineRunning = false;
        this._status("cancelled", "warning");
        break;

      case "usage_update": {
        const summary = d.summary as RunUsageSummary | undefined;
        if (summary) this._lastUsage = summary;
        break;
      }

      case "agent_text": {
        const stageId = typeof d.stageId === "string" ? d.stageId : undefined;
        const text = typeof d.text === "string" ? d.text.trim() : "";
        if (stageId && text.length > 0) {
          this._status(`${stageId} — writing`, "warning");
        }
        break;
      }

      case "agent_tool_start": {
        const stageId = typeof d.stageId === "string" ? d.stageId : undefined;
        const toolName = typeof d.toolName === "string" ? d.toolName : undefined;
        if (stageId && toolName) {
          this._status(`${stageId} — ${toolName}`, "warning");
        }
        break;
      }

      default:
        break;
    }
  }

  /** Render a final summary notification after the pipeline completes. */
  showSummary(result: PipelineResult): void {
    const icon = result.status === "success" ? "✔" : result.status === "cancelled" ? "⊘" : "✘";
    const path = result.completedNodes.join(" → ");
    const costLine = this._lastUsage
      ? ` | ${formatCost(this._lastUsage.totals.cost)}`
      : "";

    const lines: string[] = [
      `${icon} Pipeline ${result.status}`,
      `Path: ${path}${costLine}`,
    ];

    // Include failure summary details when available
    if (result.status === "fail" && result.failureSummary) {
      const fs = result.failureSummary;
      lines.push("");
      lines.push(`Failed stage: ${fs.failedNode}`);
      lines.push(`Failure class: ${fs.failureClass}`);
      lines.push(`Digest: ${fs.digest}`);
      if (fs.firstFailingCheck) {
        lines.push(`First failing check: ${fs.firstFailingCheck}`);
      }
      if (fs.rerunCommand) {
        lines.push(`Rerun: ${fs.rerunCommand}`);
      }
      if (fs.logsPath) {
        lines.push(`Logs: ${fs.logsPath}`);
      }
      if (fs.failureReason && fs.failureReason !== fs.digest) {
        lines.push(`Reason: ${fs.failureReason}`);
      }
    } else if (result.status === "fail" && result.lastOutcome?.failure_reason) {
      lines.push("");
      lines.push(`Reason: ${result.lastOutcome.failure_reason}`);
    }

    const type = result.status === "success" ? "info" : result.status === "cancelled" ? "warning" : "error";
    this._ui.notify(lines.join("\n"), type as "info" | "warning" | "error");
  }

  /** Tear down panel UI elements. */
  dispose(): void {
    this._ui.setStatus(STATUS_KEY, undefined);
  }

  // -----------------------------------------------------------------------
  // Accessors (for testing)
  // -----------------------------------------------------------------------

  get stages(): readonly StageEntry[] {
    return this._stages;
  }

  get pipelineRunning(): boolean {
    return this._pipelineRunning;
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  /** Format a status string with the attractor label, progress, and detail. */
  private _status(detail: string, color: string): void {
    const prefix = this._theme.fg("dim", `${LABEL} `);
    const progress = this._progressTag();
    const body = this._theme.fg(color, detail);
    this._ui.setStatus(STATUS_KEY, `${prefix}${progress}${body}`);
  }

  /** Return a "[2/5] " progress tag or "" if we don't know the total. */
  private _progressTag(): string {
    if (this._totalNodes <= 0) return "";
    const completed = this._stages.filter(
      (s) => s.state === "success" || s.state === "fail",
    ).length;
    return this._theme.fg("dim", `[${completed}/${this._totalNodes}] `);
  }

  /** Send a "Starting [stage]..." message to the conversation area. */
  private _sendStageStarted(name: string): void {
    this._ui.sendMessage({
      customType: CUSTOM_MESSAGE_TYPE,
      content: `▶ Starting ${name}…`,
      display: true,
      details: { stage: name, state: "started" },
    });
  }

  /** Send a stage completion message to the conversation area. */
  private _sendStageCompleted(
    name: string,
    data: Record<string, unknown>,
    entry: StageEntry | undefined,
  ): void {
    const elapsed = entry?.completedAt && entry.startedAt
      ? formatMs(entry.completedAt - entry.startedAt)
      : undefined;

    const output = typeof data.output === "string" ? data.output.trim() : "";
    const content = output
      ? (output.length > OUTPUT_PREVIEW_LIMIT
          ? output.slice(0, OUTPUT_PREVIEW_LIMIT) + "…"
          : output)
      : (data.notes ? String(data.notes) : "");

    this._ui.sendMessage({
      customType: CUSTOM_MESSAGE_TYPE,
      content,
      display: true,
      details: { stage: name, state: "success", elapsed, output: content },
    });
  }

  /** Send a stage failure message to the conversation area. */
  private _sendStageFailure(
    name: string,
    data: Record<string, unknown>,
    entry: StageEntry | undefined,
  ): void {
    const elapsed = entry?.completedAt && entry.startedAt
      ? formatMs(entry.completedAt - entry.startedAt)
      : undefined;

    const tf = data.tool_failure as Record<string, unknown> | undefined;
    const errorLines: string[] = [];

    if (tf) {
      if (tf.command) errorLines.push(`Command: ${tf.command}`);
      if (tf.exitCode != null) errorLines.push(`Exit code: ${tf.exitCode}`);
      if (tf.signal) errorLines.push(`Signal: ${tf.signal}`);
      if (tf.durationMs != null) errorLines.push(`Duration: ${formatMs(tf.durationMs as number)}`);
      if (tf.firstFailingCheck) errorLines.push(`First failing check: ${tf.firstFailingCheck}`);

      const stderrTail = tf.stderrTail as string | undefined;
      if (stderrTail && stderrTail.trim()) {
        errorLines.push("");
        errorLines.push("stderr:");
        errorLines.push(stderrTail.trim());
      }

      const stdoutTail = tf.stdoutTail as string | undefined;
      if (stdoutTail && stdoutTail.trim() && !stderrTail?.trim()) {
        errorLines.push("");
        errorLines.push("stdout:");
        errorLines.push(stdoutTail.trim());
      }

      if (tf.artifactPaths) {
        const paths = tf.artifactPaths as Record<string, string>;
        if (paths.stderr) errorLines.push(`\nFull logs: ${paths.stderr}`);
      }
    } else if (data.error) {
      errorLines.push(String(data.error));
    }

    this._ui.sendMessage({
      customType: CUSTOM_MESSAGE_TYPE,
      content: errorLines.join("\n"),
      display: true,
      details: {
        stage: name,
        state: "fail",
        elapsed,
        error: errorLines.join("\n"),
        toolFailure: tf,
      },
    });
  }

  private _findStage(name: string): StageEntry | undefined {
    for (let i = this._stages.length - 1; i >= 0; i--) {
      if (this._stages[i].name === name) return this._stages[i];
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatMs(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m${remainSecs}s`;
}

function formatCost(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.01) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(4)}`;
}
