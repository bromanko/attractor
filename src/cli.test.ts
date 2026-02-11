import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let currentGraph: any;
let currentEvents: Array<{ kind: string; data: Record<string, unknown> }> = [];

let runPipelineImpl: ((config: any) => Promise<any>) | undefined;

vi.mock("./pipeline/index.js", () => {
  return {
    parseDot: vi.fn(() => currentGraph),
    validate: vi.fn(() => []),
    validateOrRaise: vi.fn(() => undefined),
    runPipeline: vi.fn(async (config: any) => {
      if (runPipelineImpl) return runPipelineImpl(config);
      for (const event of currentEvents) {
        config.onEvent?.(event);
      }
      return { status: "success", completedNodes: [] };
    }),
    PiBackend: class PiBackend {
      constructor(_: unknown) {}
    },
    AutoApproveInterviewer: class AutoApproveInterviewer {},
  };
});

vi.mock("@mariozechner/pi-coding-agent", () => {
  return {
    AuthStorage: class AuthStorage {},
    ModelRegistry: class ModelRegistry {
      constructor(_: unknown) {}
      getAvailable() { return []; }
    },
  };
});

vi.mock("./interactive-interviewer.js", () => {
  return {
    InteractiveInterviewer: class InteractiveInterviewer {},
  };
});

const spinnerInstances: any[] = [];
vi.mock("./cli-renderer.js", () => {
  class Spinner {
    running = false;
    start = vi.fn((_: string, __?: string) => {
      this.running = true;
    });
    stop = vi.fn((_: "success" | "fail" | "retry", __?: string) => {
      this.running = false;
    });
    isRunning = vi.fn(() => this.running);

    constructor() {
      spinnerInstances.push(this);
    }
  }

  return {
    renderBanner: vi.fn(() => "BANNER"),
    renderSummary: vi.fn(() => "SUMMARY"),
    renderResumeInfo: vi.fn(() => "RESUME"),
    renderMarkdown: vi.fn((s: string) => s),
    renderFailureSummary: vi.fn(() => "FAILURE_SUMMARY"),
    renderUsageSummary: vi.fn(() => "USAGE_SUMMARY"),
    formatCost: vi.fn((c: number) => `$${c}`),
    formatDuration: vi.fn(() => "1ms"),
    Spinner,
  };
});

import { cmdRun } from "./cli.js";

describe("cmdRun spinner gating around human stages", () => {
  let tempDir: string;
  let dotPath: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "attractor-cli-test-"));
    dotPath = join(tempDir, "pipeline.dot");
    await writeFile(dotPath, "digraph G {}", "utf-8");
    currentEvents = [];
    runPipelineImpl = undefined;
    currentGraph = {
      name: "test",
      attrs: {},
      nodes: [],
      edges: [],
    };
    spinnerInstances.length = 0;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    logSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("does not start or stop spinner for human-gate stages", async () => {
    currentGraph = {
      name: "test",
      attrs: {},
      nodes: [{ id: "human_gate", attrs: { shape: "hexagon" } }],
      edges: [],
    };
    currentEvents = [
      { kind: "stage_started", data: { name: "human_gate" } },
      { kind: "stage_completed", data: { name: "human_gate" } },
      { kind: "stage_failed", data: { name: "human_gate", error: "boom" } },
      { kind: "stage_retrying", data: { name: "human_gate" } },
      { kind: "pipeline_completed", data: {} },
    ];

    await cmdRun(dotPath, { "approve-all": true });

    expect(spinnerInstances).toHaveLength(1);
    const spinner = spinnerInstances[0];
    expect(spinner.start).not.toHaveBeenCalled();
    expect(spinner.stop).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("  🙋 human_gate");
  });

  it("still starts and stops spinner for non-human stages", async () => {
    currentGraph = {
      name: "test",
      attrs: {},
      nodes: [{ id: "build", attrs: { shape: "box" } }],
      edges: [],
    };
    currentEvents = [
      { kind: "stage_started", data: { name: "build" } },
      { kind: "stage_completed", data: { name: "build" } },
      { kind: "pipeline_completed", data: {} },
    ];

    await cmdRun(dotPath, { "approve-all": true });

    expect(spinnerInstances).toHaveLength(1);
    const spinner = spinnerInstances[0];
    expect(spinner.start).toHaveBeenCalledTimes(1);
    expect(spinner.start).toHaveBeenCalledWith("build", undefined);
    expect(spinner.stop).toHaveBeenCalledTimes(1);
    expect(spinner.stop).toHaveBeenCalledWith("success");
  });
});

describe("cmdRun structured failure output", () => {
  let tempDir: string;
  let dotPath: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "attractor-cli-test-"));
    dotPath = join(tempDir, "pipeline.dot");
    await writeFile(dotPath, "digraph G {}", "utf-8");
    currentEvents = [];
    runPipelineImpl = undefined;
    currentGraph = {
      name: "test",
      attrs: {},
      nodes: [{ id: "check", attrs: { shape: "parallelogram" } }],
      edges: [],
    };
    spinnerInstances.length = 0;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    logSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("stage_failed uses tool_failure digest + log pointer", async () => {
    currentEvents = [
      {
        kind: "stage_started",
        data: { name: "check" },
      },
      {
        kind: "stage_failed",
        data: {
          name: "check",
          error: "fallback error",
          tool_failure: {
            failureClass: "exit_nonzero",
            digest: "3 tests failed",
            command: "npm test",
            artifactPaths: {
              stdout: "/tmp/logs/check/attempt-1/stdout.log",
              stderr: "/tmp/logs/check/attempt-1/stderr.log",
              meta: "/tmp/logs/check/attempt-1/meta.json",
            },
          },
        },
      },
      { kind: "pipeline_completed", data: {} },
    ];

    await cmdRun(dotPath, { "approve-all": true });

    expect(spinnerInstances).toHaveLength(1);
    const spinner = spinnerInstances[0];
    // Spinner should stop with the structured digest, not the raw error
    expect(spinner.stop).toHaveBeenCalledWith(
      "fail",
      expect.stringContaining("3 tests failed"),
    );
    expect(spinner.stop).toHaveBeenCalledWith(
      "fail",
      expect.stringContaining("logs:"),
    );
  });

  it("stage_failed for non-tool stages includes error + logs path", async () => {
    currentEvents = [
      {
        kind: "stage_started",
        data: { name: "plan_review" },
      },
      {
        kind: "stage_failed",
        data: {
          name: "plan_review",
          error: "LLM error: rate limit exceeded",
          logsPath: "/tmp/logs/plan_review",
        },
      },
      { kind: "pipeline_completed", data: {} },
    ];
    currentGraph = {
      name: "test",
      attrs: {},
      nodes: [{ id: "plan_review", attrs: { shape: "box" } }],
      edges: [],
    };

    await cmdRun(dotPath, { "approve-all": true });

    expect(spinnerInstances).toHaveLength(1);
    const spinner = spinnerInstances[0];
    expect(spinner.stop).toHaveBeenCalledWith(
      "fail",
      expect.stringContaining("rate limit exceeded"),
    );
    expect(spinner.stop).toHaveBeenCalledWith(
      "fail",
      expect.stringContaining("logs:"),
    );
    expect(spinner.stop).toHaveBeenCalledWith(
      "fail",
      expect.stringContaining("plan_review"),
    );
  });

  it("renders failure summary when pipeline result includes failureSummary", async () => {
    const { renderFailureSummary } = await import("./cli-renderer.js");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

    runPipelineImpl = async (config: any) => {
      return {
        status: "fail",
        completedNodes: ["start", "check"],
        failureSummary: {
          failedNode: "check",
          failureClass: "exit_nonzero",
          digest: "2 failed",
          rerunCommand: "npm test",
          logsPath: "/tmp/logs/check/attempt-1",
        },
      };
    };

    await cmdRun(dotPath, { "approve-all": true });

    expect(renderFailureSummary).toHaveBeenCalledWith({
      failedNode: "check",
      failureClass: "exit_nonzero",
      digest: "2 failed",
      rerunCommand: "npm test",
      logsPath: "/tmp/logs/check/attempt-1",
    });

    exitSpy.mockRestore();
  });
});

describe("cmdRun cancellation", () => {
  let tempDir: string;
  let dotPath: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "attractor-cli-test-"));
    dotPath = join(tempDir, "pipeline.dot");
    await writeFile(dotPath, "digraph G {}", "utf-8");
    currentEvents = [];
    runPipelineImpl = undefined;
    currentGraph = {
      name: "test",
      attrs: {},
      nodes: [],
      edges: [],
    };
    spinnerInstances.length = 0;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
  });

  afterEach(async () => {
    logSpy.mockRestore();
    exitSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("abort signal propagates into engine/backend", async () => {
    let receivedSignal: AbortSignal | undefined;
    runPipelineImpl = async (config: any) => {
      receivedSignal = config.abortSignal;
      return { status: "success", completedNodes: [] };
    };

    await cmdRun(dotPath, { "approve-all": true });

    expect(receivedSignal).toBeDefined();
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
  });

  it("cancellation messaging is shown and exits with 130", async () => {
    runPipelineImpl = async (config: any) => {
      config.onEvent?.({
        kind: "pipeline_cancelled",
        timestamp: new Date().toISOString(),
        data: { reason: "aborted" },
      });
      return { status: "cancelled", completedNodes: [] };
    };

    await cmdRun(dotPath, { "approve-all": true });

    const logCalls = logSpy.mock.calls.map(c => c.join(" "));
    expect(logCalls.some(c => c.includes("cancelled"))).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(130);
  });

  it("spinner is stopped on cancellation", async () => {
    currentGraph = {
      name: "test",
      attrs: {},
      nodes: [{ id: "build", attrs: { shape: "box" } }],
      edges: [],
    };

    runPipelineImpl = async (config: any) => {
      config.onEvent?.({ kind: "stage_started", timestamp: "", data: { name: "build" } });
      config.onEvent?.({ kind: "pipeline_cancelled", timestamp: "", data: { reason: "aborted" } });
      return { status: "cancelled", completedNodes: [] };
    };

    await cmdRun(dotPath, { "approve-all": true });

    expect(spinnerInstances).toHaveLength(1);
    const spinner = spinnerInstances[0];
    // Spinner should have been stopped (either by the event handler or the finally block)
    expect(spinner.stop).toHaveBeenCalled();
  });

  it("signal handlers are de-registered after run", async () => {
    const listenersBefore = process.listenerCount("SIGINT");

    runPipelineImpl = async () => ({ status: "success", completedNodes: [] });
    await cmdRun(dotPath, { "approve-all": true });

    const listenersAfter = process.listenerCount("SIGINT");
    expect(listenersAfter).toBe(listenersBefore);
  });
});

// ---------------------------------------------------------------------------
// Usage output tests
// ---------------------------------------------------------------------------

describe("cmdRun usage output", () => {
  let tempDir: string;
  let dotPath: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "attractor-cli-test-"));
    dotPath = join(tempDir, "pipeline.dot");
    await writeFile(dotPath, "digraph G {}", "utf-8");
    currentEvents = [];
    runPipelineImpl = undefined;
    currentGraph = {
      name: "test",
      attrs: {},
      nodes: [],
      edges: [],
    };
    spinnerInstances.length = 0;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    logSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("passes usageSummary from result to renderSummary", async () => {
    const { renderSummary } = await import("./cli-renderer.js");

    const usageSummary = {
      stages: [{
        stageId: "work",
        attempt: 1,
        metrics: {
          input_tokens: 100, output_tokens: 50,
          cache_read_tokens: 0, cache_write_tokens: 0,
          total_tokens: 150, cost: 0.001,
        },
      }],
      totals: {
        input_tokens: 100, output_tokens: 50,
        cache_read_tokens: 0, cache_write_tokens: 0,
        total_tokens: 150, cost: 0.001,
      },
    };

    runPipelineImpl = async () => ({
      status: "success",
      completedNodes: ["start", "work", "exit"],
      usageSummary,
    });

    await cmdRun(dotPath, { "approve-all": true });

    expect(renderSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        usageSummary,
      }),
    );
  });

  it("captures live usage_update events", async () => {
    const { renderSummary } = await import("./cli-renderer.js");

    const liveUsage = {
      stages: [{
        stageId: "work",
        attempt: 1,
        metrics: {
          input_tokens: 50, output_tokens: 25,
          cache_read_tokens: 0, cache_write_tokens: 0,
          total_tokens: 75, cost: 0.0005,
        },
      }],
      totals: {
        input_tokens: 50, output_tokens: 25,
        cache_read_tokens: 0, cache_write_tokens: 0,
        total_tokens: 75, cost: 0.0005,
      },
    };

    runPipelineImpl = async (config: any) => {
      // Emit a usage_update event (simulating live streaming)
      config.onEvent?.({
        kind: "usage_update",
        timestamp: new Date().toISOString(),
        data: {
          stageId: "work",
          attempt: 1,
          metrics: liveUsage.stages[0].metrics,
          summary: liveUsage,
        },
      });
      // Return result WITHOUT usageSummary to test fallback to live data
      return { status: "success", completedNodes: ["start", "work", "exit"] };
    };

    await cmdRun(dotPath, { "approve-all": true });

    // Should fall back to live usage when result has no usageSummary
    expect(renderSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        usageSummary: liveUsage,
      }),
    );
  });

  it("result usageSummary takes priority over live updates", async () => {
    const { renderSummary } = await import("./cli-renderer.js");

    const resultUsage = {
      stages: [{
        stageId: "work",
        attempt: 1,
        metrics: {
          input_tokens: 200, output_tokens: 100,
          cache_read_tokens: 0, cache_write_tokens: 0,
          total_tokens: 300, cost: 0.01,
        },
      }],
      totals: {
        input_tokens: 200, output_tokens: 100,
        cache_read_tokens: 0, cache_write_tokens: 0,
        total_tokens: 300, cost: 0.01,
      },
    };

    runPipelineImpl = async (config: any) => {
      // Emit a stale live usage event
      config.onEvent?.({
        kind: "usage_update",
        timestamp: new Date().toISOString(),
        data: {
          stageId: "work",
          attempt: 1,
          metrics: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 15, cost: 0.0001 },
          summary: {
            stages: [{ stageId: "work", attempt: 1, metrics: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 15, cost: 0.0001 } }],
            totals: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 15, cost: 0.0001 },
          },
        },
      });
      return {
        status: "success",
        completedNodes: ["start", "work", "exit"],
        usageSummary: resultUsage,
      };
    };

    await cmdRun(dotPath, { "approve-all": true });

    // Result usageSummary should take priority
    expect(renderSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        usageSummary: resultUsage,
      }),
    );
  });
});
