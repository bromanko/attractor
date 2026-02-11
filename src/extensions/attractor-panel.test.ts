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

  it("shows detailed failure summary with failureSummary", () => {
    panel.showSummary({
      status: "fail",
      completedNodes: ["start", "selfci_check"],
      failureSummary: {
        failedNode: "selfci_check",
        failureClass: "test_failure",
        digest: "Tests: 1 failed, 0 passed",
        firstFailingCheck: "smoke/selfci structured error",
        rerunCommand: "bash -lc 'selfci'",
        logsPath: "/tmp/logs/selfci_check",
      },
      usageSummary: { stages: [], totals: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 0, cost: 0 } },
    });
    const lastNotify = ui.calls.notify[ui.calls.notify.length - 1];
    expect(lastNotify[0]).toContain("selfci_check");
    expect(lastNotify[0]).toContain("test_failure");
    expect(lastNotify[0]).toContain("Tests: 1 failed, 0 passed");
    expect(lastNotify[0]).toContain("smoke/selfci structured error");
    expect(lastNotify[0]).toContain("bash -lc 'selfci'");
    expect(lastNotify[1]).toBe("error");
  });

  it("shows failure reason from lastOutcome when no failureSummary", () => {
    panel.showSummary({
      status: "fail",
      completedNodes: ["start", "plan"],
      lastOutcome: { status: "fail", failure_reason: "LLM rate limited" },
      usageSummary: { stages: [], totals: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 0, cost: 0 } },
    });
    const lastNotify = ui.calls.notify[ui.calls.notify.length - 1];
    expect(lastNotify[0]).toContain("LLM rate limited");
  });

  it("notifies on stage failure with tool details", () => {
    panel.handleEvent(makeEvent("stage_started", { name: "selfci_check" }));
    panel.handleEvent(makeEvent("stage_failed", {
      name: "selfci_check",
      error: "Tool failed",
      tool_failure: {
        command: "bash -lc 'selfci'",
        exitCode: 1,
        signal: null,
        durationMs: 1234,
        failureClass: "test_failure",
        digest: "Tests: 1 failed",
        stderrTail: "FAIL  smoke/selfci structured error\nTests: 1 failed, 0 passed",
        stdoutTail: "selfci smoke run",
        firstFailingCheck: "smoke/selfci structured error",
        artifactPaths: { stdout: "/tmp/stdout.log", stderr: "/tmp/stderr.log", meta: "/tmp/meta.json" },
      },
    }));

    // Should have emitted a notification with tool failure details
    const failNotify = ui.calls.notify.find((c: any[]) => c[1] === "error" && c[0].includes("selfci_check"));
    expect(failNotify).toBeDefined();
    expect(failNotify![0]).toContain("bash -lc 'selfci'");
    expect(failNotify![0]).toContain("Exit code: 1");
    expect(failNotify![0]).toContain("FAIL  smoke/selfci structured error");
    expect(failNotify![0]).toContain("First failing check: smoke/selfci structured error");
  });

  it("notifies on stage failure with plain error", () => {
    panel.handleEvent(makeEvent("stage_started", { name: "plan" }));
    panel.handleEvent(makeEvent("stage_failed", {
      name: "plan",
      error: "LLM timeout after 30s",
    }));

    const failNotify = ui.calls.notify.find((c: any[]) => c[1] === "error" && c[0].includes("plan"));
    expect(failNotify).toBeDefined();
    expect(failNotify![0]).toContain("LLM timeout after 30s");
  });

  it("notifies on pipeline_failed with error reason", () => {
    panel.handleEvent(makeEvent("pipeline_started", {}));
    panel.handleEvent(makeEvent("pipeline_failed", { error: "Stage failed with no outgoing edge: selfci_check" }));

    const failNotify = ui.calls.notify.find((c: any[]) => c[1] === "error");
    expect(failNotify).toBeDefined();
    expect(failNotify![0]).toContain("Stage failed with no outgoing edge: selfci_check");
  });

  it("shows streaming LLM text in widget", () => {
    panel.handleEvent(makeEvent("stage_started", { name: "plan" }));
    panel.handleEvent(makeEvent("agent_text", { stageId: "plan", text: "Let me analyze " }));
    panel.handleEvent(makeEvent("agent_text", { stageId: "plan", text: "the codebase..." }));

    const lastWidget = ui.calls.setWidget[ui.calls.setWidget.length - 1];
    expect(lastWidget[1]).toBeDefined();
    // Widget should contain the streaming text preview
    const widgetText = lastWidget[1].join("\n");
    expect(widgetText).toContain("plan");
    expect(widgetText).toContain("the codebase");
  });

  it("shows active tool calls in widget", () => {
    panel.handleEvent(makeEvent("stage_started", { name: "implement" }));
    panel.handleEvent(makeEvent("agent_tool_start", { stageId: "implement", toolName: "bash", toolCallId: "t1" }));

    const lastWidget = ui.calls.setWidget[ui.calls.setWidget.length - 1];
    const widgetText = lastWidget[1].join("\n");
    expect(widgetText).toContain("bash");

    // Status should show the tool
    expect(ui.setStatus).toHaveBeenCalledWith("attractor", expect.stringContaining("bash"));
  });

  it("removes tool from active list on agent_tool_end", () => {
    panel.handleEvent(makeEvent("stage_started", { name: "implement" }));
    panel.handleEvent(makeEvent("agent_tool_start", { stageId: "implement", toolName: "bash", toolCallId: "t1" }));
    panel.handleEvent(makeEvent("agent_tool_end", { stageId: "implement", toolName: "bash", toolCallId: "t1", isError: false }));

    const lastWidget = ui.calls.setWidget[ui.calls.setWidget.length - 1];
    const widgetText = lastWidget[1].join("\n");
    // bash should no longer appear as active tool (only the stage line)
    expect(widgetText).not.toContain("↳ bash");
  });

  it("disposes panel UI and clears widget on success", () => {
    panel.handleEvent(makeEvent("pipeline_completed"));
    panel.dispose();
    expect(ui.setStatus).toHaveBeenCalledWith("attractor", undefined);
    expect(ui.setWidget).toHaveBeenCalledWith("attractor-progress", undefined);
  });

  it("keeps widget visible after failure on dispose", () => {
    panel.handleEvent(makeEvent("stage_started", { name: "build" }));
    panel.handleEvent(makeEvent("stage_failed", { name: "build", error: "oops" }));
    panel.handleEvent(makeEvent("pipeline_failed", { error: "boom" }));

    // Reset mock tracking to see what dispose does
    (ui.setWidget as ReturnType<typeof vi.fn>).mockClear();
    panel.dispose();

    // Status is always cleared, but widget should NOT be cleared after failure
    expect(ui.setStatus).toHaveBeenCalledWith("attractor", undefined);
    expect(ui.setWidget).not.toHaveBeenCalled();
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
