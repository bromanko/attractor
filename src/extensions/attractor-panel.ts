/**
 * attractor-panel.ts — Rich TUI panel for Attractor pipeline execution.
 *
 * Drives widgets, status, and notifications through pi's ctx.ui to show:
 *  - Pipeline lifecycle progress
 *  - Per-node stage status (running / completed / failed)
 *  - Gate prompts and decisions
 *  - Final summary
 */

import type { PipelineEvent } from "../pipeline/types.js";
import type { PipelineResult } from "../pipeline/engine.js";
import type { RunUsageSummary, UsageMetrics } from "../pipeline/types.js";

// ---------------------------------------------------------------------------
// Minimal UI surface (subset of ExtensionUIContext / ExtensionContext)
// ---------------------------------------------------------------------------

export interface PanelUI {
  setStatus(key: string, text: string | undefined): void;
  setWidget(key: string, content: string[] | undefined): void;
  notify(message: string, type?: "info" | "warning" | "error"): void;
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
  /** Accumulated streaming text from the LLM for this stage. */
  streamText?: string;
  /** Active tool calls within this stage's agent session. */
  activeTools?: string[];
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

const STATUS_KEY = "attractor";
const WIDGET_KEY = "attractor-progress";

export class AttractorPanel {
  private _ui: PanelUI;
  private _theme: PanelTheme;
  private _stages: StageEntry[] = [];
  private _pipelineRunning = false;
  private _lastUsage: RunUsageSummary | undefined;
  private _keepWidget = false;

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
        this._ui.setStatus(STATUS_KEY, this._theme.fg("warning", "▶ running"));
        break;

      case "pipeline_resumed":
        this._pipelineRunning = true;
        this._ui.setStatus(STATUS_KEY, this._theme.fg("warning", `♻ resuming at ${d.from}`));
        break;

      case "stage_started": {
        const name = String(d.name);
        this._stages.push({ name, state: "running", startedAt: Date.now() });
        this._ui.setStatus(STATUS_KEY, this._theme.fg("warning", `▶ ${name}`));
        this._renderWidget();
        break;
      }

      case "stage_completed": {
        const name = String(d.name);
        const entry = this._findStage(name);
        if (entry) {
          entry.state = "success";
          entry.completedAt = Date.now();
        }
        this._renderWidget();

        // Notify with any available output details
        if (d.notes) {
          this._ui.notify(`${this._theme.fg("success", "✔")} ${name}: ${d.notes}`, "info");
        }
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
        this._renderWidget();

        // Emit a detailed failure notification
        this._notifyStageFailure(name, d);
        break;
      }

      case "stage_retrying": {
        const name = String(d.name);
        const entry = this._findStage(name);
        if (entry) entry.state = "retry";
        this._renderWidget();
        break;
      }

      case "pipeline_completed":
        this._pipelineRunning = false;
        this._ui.setStatus(STATUS_KEY, this._theme.fg("success", "✔ completed"));
        this._renderWidget();
        break;

      case "pipeline_failed": {
        this._pipelineRunning = false;
        this._keepWidget = true;
        this._ui.setStatus(STATUS_KEY, this._theme.fg("error", "✘ failed"));
        this._renderWidget();
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
        this._keepWidget = true;
        this._ui.setStatus(STATUS_KEY, this._theme.fg("warning", "⊘ cancelled"));
        this._renderWidget();
        break;

      case "usage_update": {
        const summary = d.summary as RunUsageSummary | undefined;
        if (summary) this._lastUsage = summary;
        break;
      }

      case "agent_text": {
        const stageId = String(d.stageId);
        const entry = this._findStage(stageId);
        if (entry) {
          entry.streamText = (entry.streamText ?? "") + String(d.text);
          this._ui.setStatus(STATUS_KEY, this._theme.fg("warning", `▶ ${stageId} — streaming`));
          this._renderWidget();
        }
        break;
      }

      case "agent_tool_start": {
        const stageId = String(d.stageId);
        const toolName = String(d.toolName);
        const entry = this._findStage(stageId);
        if (entry) {
          if (!entry.activeTools) entry.activeTools = [];
          entry.activeTools.push(toolName);
          this._ui.setStatus(STATUS_KEY, this._theme.fg("warning", `▶ ${stageId} → ${toolName}`));
          this._renderWidget();
        }
        break;
      }

      case "agent_tool_end": {
        const stageId = String(d.stageId);
        const toolName = String(d.toolName);
        const entry = this._findStage(stageId);
        if (entry && entry.activeTools) {
          const idx = entry.activeTools.indexOf(toolName);
          if (idx >= 0) entry.activeTools.splice(idx, 1);
          this._renderWidget();
        }
        break;
      }
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

  /** Tear down panel UI elements.
   *  Keeps the widget visible after failure/cancellation so the user can
   *  review stage history. Only clears on success (clean exit). */
  dispose(): void {
    this._ui.setStatus(STATUS_KEY, undefined);
    // Keep widget visible after failure so stages remain readable
    if (!this._keepWidget) {
      this._ui.setWidget(WIDGET_KEY, undefined);
    }
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

  private _notifyStageFailure(name: string, data: Record<string, unknown>): void {
    const lines: string[] = [`${this._theme.fg("error", "✘")} Stage failed: ${this._theme.bold(name)}`];

    const tf = data.tool_failure as Record<string, unknown> | undefined;
    if (tf) {
      // Rich tool failure details
      if (tf.command) lines.push(`Command: ${tf.command}`);
      if (tf.exitCode != null) lines.push(`Exit code: ${tf.exitCode}`);
      if (tf.signal) lines.push(`Signal: ${tf.signal}`);
      if (tf.durationMs != null) lines.push(`Duration: ${formatMs(tf.durationMs as number)}`);
      if (tf.firstFailingCheck) lines.push(`First failing check: ${tf.firstFailingCheck}`);

      const stderrTail = tf.stderrTail as string | undefined;
      if (stderrTail && stderrTail.trim()) {
        lines.push("");
        lines.push("stderr:");
        lines.push(stderrTail.trim());
      }

      const stdoutTail = tf.stdoutTail as string | undefined;
      if (stdoutTail && stdoutTail.trim() && !stderrTail?.trim()) {
        lines.push("");
        lines.push("stdout:");
        lines.push(stdoutTail.trim());
      }
    } else if (data.error) {
      lines.push(String(data.error));
    }

    if (tf?.artifactPaths) {
      const paths = tf.artifactPaths as Record<string, string>;
      if (paths.stderr) lines.push(`\nFull logs: ${paths.stderr}`);
    }

    this._ui.notify(lines.join("\n"), "error");
  }

  private _findStage(name: string): StageEntry | undefined {
    // Find the most recent entry with this name (handles retries)
    for (let i = this._stages.length - 1; i >= 0; i--) {
      if (this._stages[i].name === name) return this._stages[i];
    }
    return undefined;
  }

  private _renderWidget(): void {
    const lines: string[] = [];

    for (const s of this._stages) {
      const icon = this._stateIcon(s.state);
      const elapsed = s.completedAt && s.startedAt
        ? ` (${formatMs(s.completedAt - s.startedAt)})`
        : s.startedAt
          ? ` (${formatMs(Date.now() - s.startedAt)})`
          : "";
      const errorSuffix = s.error ? ` — ${s.error}` : "";
      const color = this._stateColor(s.state);
      lines.push(this._theme.fg(color, `${icon} ${s.name}${elapsed}${errorSuffix}`));

      // Show active tools for running stages
      if (s.state === "running" && s.activeTools && s.activeTools.length > 0) {
        lines.push(this._theme.fg("muted", `    ↳ ${s.activeTools.join(", ")}`));
      }

      // Show streaming LLM text preview for running stages
      if (s.state === "running" && s.streamText) {
        const preview = truncateStreamPreview(s.streamText, 200);
        lines.push(this._theme.fg("dim", `    ${preview}`));
      }
    }

    this._ui.setWidget(WIDGET_KEY, lines.length > 0 ? lines : undefined);
  }

  private _stateIcon(state: StageState): string {
    switch (state) {
      case "pending": return "○";
      case "running": return "◉";
      case "success": return "✔";
      case "fail": return "✘";
      case "retry": return "↻";
      case "cancelled": return "⊘";
    }
  }

  private _stateColor(state: StageState): string {
    switch (state) {
      case "pending": return "dim";
      case "running": return "warning";
      case "success": return "success";
      case "fail": return "error";
      case "retry": return "warning";
      case "cancelled": return "muted";
    }
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Show the last N chars of streaming text, collapsed to a single line. */
function truncateStreamPreview(text: string, maxLen: number): string {
  // Take the last portion and collapse to single line
  const tail = text.length > maxLen ? text.slice(-maxLen) : text;
  const oneLine = tail.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  return oneLine.length > maxLen
    ? "…" + oneLine.slice(-(maxLen - 1))
    : oneLine;
}

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
