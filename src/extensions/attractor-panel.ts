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

      case "pipeline_failed":
        this._pipelineRunning = false;
        this._ui.setStatus(STATUS_KEY, this._theme.fg("error", "✘ failed"));
        this._renderWidget();
        break;

      case "pipeline_cancelled":
        this._pipelineRunning = false;
        this._ui.setStatus(STATUS_KEY, this._theme.fg("warning", "⊘ cancelled"));
        this._renderWidget();
        break;

      case "usage_update": {
        const summary = d.summary as RunUsageSummary | undefined;
        if (summary) this._lastUsage = summary;
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

    const msg = `${icon} Pipeline ${result.status}\nPath: ${path}${costLine}`;
    const type = result.status === "success" ? "info" : result.status === "cancelled" ? "warning" : "error";
    this._ui.notify(msg, type as "info" | "warning" | "error");
  }

  /** Tear down panel UI elements. */
  dispose(): void {
    this._ui.setStatus(STATUS_KEY, undefined);
    this._ui.setWidget(WIDGET_KEY, undefined);
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
