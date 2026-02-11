import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PipelineEvent } from "../pipeline/types.js";
import { AttractorPanel, type PanelUI, type PanelTheme } from "./attractor-panel.js";

function mockUI(): PanelUI & { calls: Record<string, any[]> } {
  const calls: Record<string, any[]> = {
    setStatus: [],
    setWidget: [],
    notify: [],
  };
  return {
    calls,
    setStatus: vi.fn((...args) => calls.setStatus.push(args)),
    setWidget: vi.fn((...args) => calls.setWidget.push(args)),
    notify: vi.fn((...args) => calls.notify.push(args)),
  };
}

function mockTheme(): PanelTheme {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    strikethrough: (text: string) => text,
  };
}

function makeEvent(kind: string, data: Record<string, unknown> = {}): PipelineEvent {
  return {
    kind: kind as PipelineEvent["kind"],
    timestamp: new Date().toISOString(),
    data,
  };
}

describe("AttractorPanel", () => {
  let ui: ReturnType<typeof mockUI>;
  let theme: PanelTheme;
  let panel: AttractorPanel;

  beforeEach(() => {
    ui = mockUI();
    theme = mockTheme();
    panel = new AttractorPanel(ui, theme);
  });

  it("tracks pipeline lifecycle", () => {
    panel.handleEvent(makeEvent("pipeline_started", { name: "Test" }));
    expect(panel.pipelineRunning).toBe(true);
    expect(ui.setStatus).toHaveBeenCalledWith("attractor", expect.stringContaining("running"));

    panel.handleEvent(makeEvent("pipeline_completed"));
    expect(panel.pipelineRunning).toBe(false);
    expect(ui.setStatus).toHaveBeenCalledWith("attractor", expect.stringContaining("completed"));
  });

  it("tracks stage lifecycle", () => {
    panel.handleEvent(makeEvent("stage_started", { name: "plan" }));
    expect(panel.stages).toHaveLength(1);
    expect(panel.stages[0].state).toBe("running");

    panel.handleEvent(makeEvent("stage_completed", { name: "plan" }));
    expect(panel.stages[0].state).toBe("success");
  });

  it("tracks stage failure", () => {
    panel.handleEvent(makeEvent("stage_started", { name: "build" }));
    panel.handleEvent(makeEvent("stage_failed", { name: "build", error: "compile error" }));
    expect(panel.stages[0].state).toBe("fail");
    expect(panel.stages[0].error).toBe("compile error");
  });

  it("tracks stage retry", () => {
    panel.handleEvent(makeEvent("stage_started", { name: "flaky" }));
    panel.handleEvent(makeEvent("stage_retrying", { name: "flaky" }));
    expect(panel.stages[0].state).toBe("retry");
  });

  it("handles pipeline_failed", () => {
    panel.handleEvent(makeEvent("pipeline_started", {}));
    panel.handleEvent(makeEvent("pipeline_failed", { error: "boom" }));
    expect(panel.pipelineRunning).toBe(false);
    expect(ui.setStatus).toHaveBeenCalledWith("attractor", expect.stringContaining("failed"));
  });

  it("handles pipeline_cancelled", () => {
    panel.handleEvent(makeEvent("pipeline_started", {}));
    panel.handleEvent(makeEvent("pipeline_cancelled", {}));
    expect(panel.pipelineRunning).toBe(false);
    expect(ui.setStatus).toHaveBeenCalledWith("attractor", expect.stringContaining("cancelled"));
  });

  it("handles pipeline_resumed", () => {
    panel.handleEvent(makeEvent("pipeline_resumed", { from: "step2" }));
    expect(panel.pipelineRunning).toBe(true);
    expect(ui.setStatus).toHaveBeenCalledWith("attractor", expect.stringContaining("resuming"));
  });

  it("renders widget with stage list", () => {
    panel.handleEvent(makeEvent("stage_started", { name: "plan" }));
    panel.handleEvent(makeEvent("stage_completed", { name: "plan" }));
    panel.handleEvent(makeEvent("stage_started", { name: "implement" }));

    // Widget should have been set with lines for both stages
    expect(ui.setWidget).toHaveBeenCalled();
    const lastWidgetCall = ui.calls.setWidget[ui.calls.setWidget.length - 1];
    expect(lastWidgetCall[0]).toBe("attractor-progress");
    expect(lastWidgetCall[1]).toHaveLength(2);
  });

  it("shows summary notification", () => {
    panel.showSummary({
      status: "success",
      completedNodes: ["start", "plan", "exit"],
      usageSummary: { stages: [], totals: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 0, cost: 0 } },
    });
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("success"),
      "info",
    );
  });

  it("shows failure summary", () => {
    panel.showSummary({
      status: "fail",
      completedNodes: ["start", "plan"],
      usageSummary: { stages: [], totals: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 0, cost: 0 } },
    });
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("fail"),
      "error",
    );
  });

  it("disposes panel UI", () => {
    panel.dispose();
    expect(ui.setStatus).toHaveBeenCalledWith("attractor", undefined);
    expect(ui.setWidget).toHaveBeenCalledWith("attractor-progress", undefined);
  });

  it("captures usage data", () => {
    panel.handleEvent(makeEvent("usage_update", {
      summary: {
        stages: [{ stageId: "plan", attempt: 1, metrics: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 150, cost: 0.01 } }],
        totals: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 150, cost: 0.01 },
      },
    }));

    panel.showSummary({
      status: "success",
      completedNodes: ["start", "plan", "exit"],
      usageSummary: { stages: [], totals: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 150, cost: 0.01 } },
    });

    // The summary notification should include cost info
    const lastNotify = ui.calls.notify[ui.calls.notify.length - 1];
    expect(lastNotify[0]).toContain("$0.01");
  });
});
