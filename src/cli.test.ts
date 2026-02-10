import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let currentGraph: any;
let currentEvents: Array<{ kind: string; data: Record<string, unknown> }> = [];

vi.mock("./pipeline/index.js", () => {
  return {
    parseDot: vi.fn(() => currentGraph),
    validate: vi.fn(() => []),
    validateOrRaise: vi.fn(() => undefined),
    runPipeline: vi.fn(async (config: any) => {
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
