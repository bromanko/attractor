import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PipelineEvent } from "../pipeline/types.js";
import { AttractorPanel, type PanelUI, type PanelTheme } from "./attractor-panel.js";

function mockUI(): PanelUI & { calls: Record<string, any[]> } {
  const calls: Record<string, any[]> = {
    setStatus: [],
    notify: [],
    sendMessage: [],
  };
  return {
    calls,
    setStatus: vi.fn((...args) => calls.setStatus.push(args)),
    notify: vi.fn((...args) => calls.notify.push(args)),
    sendMessage: vi.fn((...args) => calls.sendMessage.push(args)),
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

  // -----------------------------------------------------------------------
  // Status bar
  // -----------------------------------------------------------------------

  it("tracks pipeline lifecycle with label and progress", () => {
    panel.handleEvent(makeEvent("pipeline_started", { name: "Test", nodeCount: 5 }));
    expect(panel.pipelineRunning).toBe(true);
    expect(ui.setStatus).toHaveBeenCalledWith("attractor", expect.stringContaining("attractor"));
    expect(ui.setStatus).toHaveBeenCalledWith("attractor", expect.stringContaining("running"));

    panel.handleEvent(makeEvent("pipeline_completed"));
    expect(panel.pipelineRunning).toBe(false);
    expect(ui.setStatus).toHaveBeenCalledWith("attractor", expect.stringContaining("completed"));
  });

  it("shows progress count in status", () => {
    panel.handleEvent(makeEvent("pipeline_started", { name: "Test", nodeCount: 4 }));
    panel.handleEvent(makeEvent("stage_started", { name: "plan" }));
    panel.handleEvent(makeEvent("stage_completed", { name: "plan" }));
    panel.handleEvent(makeEvent("stage_started", { name: "implement" }));

    const lastCall = ui.calls.setStatus[ui.calls.setStatus.length - 1];
    expect(lastCall[1]).toContain("attractor");
    expect(lastCall[1]).toContain("1/4");
    expect(lastCall[1]).toContain("implement");
  });

  it("shows spinner on stage start", () => {
    panel.handleEvent(makeEvent("pipeline_started", { name: "Test", nodeCount: 3 }));
    panel.handleEvent(makeEvent("stage_started", { name: "plan" }));
    const statusText = ui.calls.setStatus[ui.calls.setStatus.length - 1][1];
    // Should contain a spinner frame (braille character)
    expect(statusText).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });

  it("shows tool name in status on agent_tool_start", () => {
    panel.handleEvent(makeEvent("stage_started", { name: "implement" }));
    panel.handleEvent(makeEvent("agent_tool_start", { stageId: "implement", toolName: "bash", toolCallId: "t1" }));
    const statusText = ui.calls.setStatus[ui.calls.setStatus.length - 1][1];
    expect(statusText).toContain("implement");
    expect(statusText).toContain("bash");
  });

  it("shows streaming indicator on agent_text", () => {
    panel.handleEvent(makeEvent("stage_started", { name: "plan" }));
    panel.handleEvent(makeEvent("agent_text", { stageId: "plan", text: "analyzing..." }));
    const statusText = ui.calls.setStatus[ui.calls.setStatus.length - 1][1];
    expect(statusText).toContain("plan");
    expect(statusText).toContain("streaming");
  });

  it("shows retry in status", () => {
    panel.handleEvent(makeEvent("stage_started", { name: "flaky" }));
    panel.handleEvent(makeEvent("stage_retrying", { name: "flaky" }));
    expect(panel.stages[0].state).toBe("retry");
    expect(ui.setStatus).toHaveBeenCalledWith("attractor", expect.stringContaining("retrying"));
  });

  it("handles pipeline_failed status", () => {
    panel.handleEvent(makeEvent("pipeline_started", {}));
    panel.handleEvent(makeEvent("pipeline_failed", { error: "boom" }));
    expect(panel.pipelineRunning).toBe(false);
    expect(ui.setStatus).toHaveBeenCalledWith("attractor", expect.stringContaining("failed"));
  });

  it("handles pipeline_cancelled status", () => {
    panel.handleEvent(makeEvent("pipeline_started", {}));
    panel.handleEvent(makeEvent("pipeline_cancelled", {}));
    expect(panel.pipelineRunning).toBe(false);
    expect(ui.setStatus).toHaveBeenCalledWith("attractor", expect.stringContaining("cancelled"));
  });

  it("handles pipeline_resumed status", () => {
    panel.handleEvent(makeEvent("pipeline_resumed", { from: "step2" }));
    expect(panel.pipelineRunning).toBe(true);
    expect(ui.setStatus).toHaveBeenCalledWith("attractor", expect.stringContaining("resuming"));
  });

  it("clears status on dispose", () => {
    panel.dispose();
    expect(ui.setStatus).toHaveBeenCalledWith("attractor", undefined);
  });

  // -----------------------------------------------------------------------
  // Stage completion notifications
  // -----------------------------------------------------------------------

  it("sends message on stage completion with output", () => {
    panel.handleEvent(makeEvent("stage_started", { name: "build" }));
    panel.handleEvent(makeEvent("stage_completed", {
      name: "build",
      output: "Compiled 42 files successfully.\nAll modules linked.",
    }));

    const msg = ui.calls.sendMessage.find((c: any[]) => c[0].details.stage === "build");
    expect(msg).toBeDefined();
    expect(msg![0].details.state).toBe("success");
    expect(msg![0].details.output).toContain("Compiled 42 files");
  });

  it("sends message on stage completion with notes when no output", () => {
    panel.handleEvent(makeEvent("stage_started", { name: "ws_create" }));
    panel.handleEvent(makeEvent("stage_completed", {
      name: "ws_create",
      notes: "Workspace created at /tmp/ws",
    }));

    const msg = ui.calls.sendMessage.find((c: any[]) => c[0].details.stage === "ws_create");
    expect(msg).toBeDefined();
    expect(msg![0].details.output).toContain("Workspace created");
  });

  it("truncates long output in completion message", () => {
    const longOutput = "x".repeat(1000);
    panel.handleEvent(makeEvent("stage_started", { name: "verbose" }));
    panel.handleEvent(makeEvent("stage_completed", { name: "verbose", output: longOutput }));

    const msg = ui.calls.sendMessage.find((c: any[]) => c[0].details.stage === "verbose");
    expect(msg).toBeDefined();
    expect(msg![0].content).toContain("…");
    expect(msg![0].content.length).toBeLessThan(longOutput.length);
  });

  it("includes elapsed time in completion message", () => {
    panel.handleEvent(makeEvent("stage_started", { name: "slow" }));
    const entry = panel.stages[0] as any;
    entry.startedAt = Date.now() - 5000;
    panel.handleEvent(makeEvent("stage_completed", { name: "slow", output: "done" }));

    const msg = ui.calls.sendMessage.find((c: any[]) => c[0].details.stage === "slow");
    expect(msg![0].details.elapsed).toMatch(/\d+s/);
  });

  // -----------------------------------------------------------------------
  // Stage failure notifications
  // -----------------------------------------------------------------------

  it("sends message on stage failure with tool details", () => {
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

    const msg = ui.calls.sendMessage.find((c: any[]) => c[0].details.stage === "selfci_check");
    expect(msg).toBeDefined();
    expect(msg![0].details.state).toBe("fail");
    expect(msg![0].content).toContain("bash -lc 'selfci'");
    expect(msg![0].content).toContain("Exit code: 1");
    expect(msg![0].content).toContain("FAIL  smoke/selfci structured error");
    expect(msg![0].content).toContain("First failing check: smoke/selfci structured error");
  });

  it("sends message on stage failure with plain error", () => {
    panel.handleEvent(makeEvent("stage_started", { name: "plan" }));
    panel.handleEvent(makeEvent("stage_failed", {
      name: "plan",
      error: "LLM timeout after 30s",
    }));

    const msg = ui.calls.sendMessage.find((c: any[]) => c[0].details.stage === "plan");
    expect(msg).toBeDefined();
    expect(msg![0].details.state).toBe("fail");
    expect(msg![0].content).toContain("LLM timeout after 30s");
  });

  it("notifies on pipeline_failed with error reason", () => {
    panel.handleEvent(makeEvent("pipeline_started", {}));
    panel.handleEvent(makeEvent("pipeline_failed", { error: "Stage failed with no outgoing edge: selfci_check" }));

    const failNotify = ui.calls.notify.find((c: any[]) => c[1] === "error");
    expect(failNotify).toBeDefined();
    expect(failNotify![0]).toContain("Stage failed with no outgoing edge: selfci_check");
  });

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------

  it("shows summary notification on success", () => {
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

  it("includes cost in summary", () => {
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

    const lastNotify = ui.calls.notify[ui.calls.notify.length - 1];
    expect(lastNotify[0]).toContain("$0.01");
  });
});
