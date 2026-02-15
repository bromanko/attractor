import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PipelineEvent } from "../pipeline/types.js";
import {
  AttractorPanel,
  type PanelUI,
  type PanelTheme,
  type StageMessage,
  type StageMessageDetails,
} from "./attractor-panel.js";

type NotifyType = "info" | "warning" | "error" | undefined;

type MockUICalls = {
  setStatus: [key: string, text: string | undefined][];
  notify: [message: string, type?: NotifyType][];
  sendMessage: [message: StageMessage][];
};

function mockUI(): PanelUI & { calls: MockUICalls } {
  const calls: MockUICalls = {
    setStatus: [],
    notify: [],
    sendMessage: [],
  };
  return {
    calls,
    setStatus: vi.fn((key: string, text: string | undefined) => calls.setStatus.push([key, text])),
    notify: vi.fn((message: string, type?: NotifyType) => calls.notify.push([message, type])),
    sendMessage: vi.fn((message: StageMessage) => calls.sendMessage.push([message])),
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

function findStageMessage(
  ui: ReturnType<typeof mockUI>,
  details: Pick<StageMessageDetails, "stage" | "state">,
): StageMessage | undefined {
  return ui.calls.sendMessage
    .map(([message]) => message)
    .find((message) =>
      message.details.stage === details.stage &&
      message.details.state === details.state,
    );
}

function findStageMessageByState(
  ui: ReturnType<typeof mockUI>,
  state: StageMessageDetails["state"],
): StageMessage | undefined {
  return ui.calls.sendMessage
    .map(([message]) => message)
    .find((message) => message.details.state === state);
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

  it("shows stage name in status on stage start", () => {
    panel.handleEvent(makeEvent("pipeline_started", { name: "Test", nodeCount: 3 }));
    panel.handleEvent(makeEvent("stage_started", { name: "plan" }));
    expect(ui.setStatus).toHaveBeenCalledWith("attractor", expect.stringContaining("plan"));
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
  // Stage start messages
  // -----------------------------------------------------------------------

  it("sends 'Starting [stage]...' message on stage start", () => {
    panel.handleEvent(makeEvent("stage_started", { name: "plan" }));
    const msg = findStageMessageByState(ui, "started");
    expect(msg).toBeDefined();
    expect(msg!.details.stage).toBe("plan");
    expect(msg!.details.state).toBe("started");
  });

  // -----------------------------------------------------------------------
  // Stage completion messages
  // -----------------------------------------------------------------------

  it("sends message on stage completion with output", () => {
    panel.handleEvent(makeEvent("stage_started", { name: "build" }));
    panel.handleEvent(makeEvent("stage_completed", {
      name: "build",
      output: "Compiled 42 files successfully.\nAll modules linked.",
    }));

    const msg = findStageMessage(ui, { stage: "build", state: "success" });
    expect(msg).toBeDefined();
    expect(msg!.details.output).toContain("Compiled 42 files");
  });

  it("sends message on stage completion with notes when no output", () => {
    panel.handleEvent(makeEvent("stage_started", { name: "ws_create" }));
    panel.handleEvent(makeEvent("stage_completed", {
      name: "ws_create",
      notes: "Workspace created at /tmp/ws",
    }));

    const msg = findStageMessage(ui, { stage: "ws_create", state: "success" });
    expect(msg).toBeDefined();
    expect(msg!.details.output).toContain("Workspace created");
  });

  it("truncates long output in completion message", () => {
    const longOutput = "x".repeat(1000);
    panel.handleEvent(makeEvent("stage_started", { name: "verbose" }));
    panel.handleEvent(makeEvent("stage_completed", { name: "verbose", output: longOutput }));

    const msg = findStageMessage(ui, { stage: "verbose", state: "success" });
    expect(msg).toBeDefined();
    expect(msg!.content).toContain("…");
    expect(msg!.content.length).toBeLessThan(longOutput.length);
  });

  it("includes elapsed time in completion message", () => {
    panel.handleEvent(makeEvent("stage_started", { name: "slow" }));
    const entry = panel.stages[0] as { startedAt?: number };
    entry.startedAt = Date.now() - 5000;
    panel.handleEvent(makeEvent("stage_completed", { name: "slow", output: "done" }));

    const msg = findStageMessage(ui, { stage: "slow", state: "success" });
    expect(msg!.details.elapsed).toMatch(/\d+s/);
  });

  // -----------------------------------------------------------------------
  // Stage failure messages
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

    const msg = findStageMessage(ui, { stage: "selfci_check", state: "fail" });
    expect(msg).toBeDefined();
    expect(msg!.content).toContain("bash -lc 'selfci'");
    expect(msg!.content).toContain("Exit code: 1");
    expect(msg!.content).toContain("FAIL  smoke/selfci structured error");
    expect(msg!.content).toContain("First failing check: smoke/selfci structured error");
  });

  it("sends message on stage failure with plain error", () => {
    panel.handleEvent(makeEvent("stage_started", { name: "plan" }));
    panel.handleEvent(makeEvent("stage_failed", {
      name: "plan",
      error: "LLM timeout after 30s",
    }));

    const msg = findStageMessage(ui, { stage: "plan", state: "fail" });
    expect(msg).toBeDefined();
    expect(msg!.content).toContain("LLM timeout after 30s");
  });

  it("notifies on pipeline_failed with error reason", () => {
    panel.handleEvent(makeEvent("pipeline_started", {}));
    panel.handleEvent(makeEvent("pipeline_failed", { error: "Stage failed with no outgoing edge: selfci_check" }));

    const failNotify = ui.calls.notify.find((c) => c[1] === "error");
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

  // -----------------------------------------------------------------------
  // Agent status events
  // -----------------------------------------------------------------------

  it("updates status on agent_text events", () => {
    panel.handleEvent(makeEvent("pipeline_started", { nodeCount: 3 }));
    panel.handleEvent(makeEvent("stage_started", { name: "plan" }));
    panel.handleEvent(makeEvent("agent_text", { stageId: "plan", text: "Working on draft" }));

    const lastCall = ui.calls.setStatus[ui.calls.setStatus.length - 1];
    expect(lastCall[1]).toContain("plan");
    expect(lastCall[1]).toContain("writing");
  });

  it("updates status on agent_tool_start events", () => {
    panel.handleEvent(makeEvent("pipeline_started", { nodeCount: 3 }));
    panel.handleEvent(makeEvent("stage_started", { name: "plan" }));
    panel.handleEvent(makeEvent("agent_tool_start", { stageId: "plan", toolName: "bash" }));

    const lastCall = ui.calls.setStatus[ui.calls.setStatus.length - 1];
    expect(lastCall[1]).toContain("plan");
    expect(lastCall[1]).toContain("bash");
  });
});
