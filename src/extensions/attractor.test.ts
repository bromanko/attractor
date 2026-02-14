import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { PipelineEvent } from "../pipeline/types.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const registeredCommands = new Map<string, { handler: Function; description?: string; getArgumentCompletions?: Function }>();

let runPipelineImpl: ((config: any) => Promise<any>) | undefined;
let parseWorkflowKdlImpl: ((source: string) => any) | undefined;

const execFileMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

vi.mock("../pipeline/index.js", () => {
  const graph = {
    name: "TestPipeline",
    attrs: { goal: "test goal" },
    nodes: [
      { id: "start", attrs: { shape: "Mdiamond", label: "Start" } },
      { id: "work", attrs: { shape: "box", label: "Work" } },
      { id: "exit", attrs: { shape: "Msquare", label: "Exit" } },
    ],
    edges: [
      { from: "start", to: "work", attrs: {} },
      { from: "work", to: "exit", attrs: {} },
    ],
    node_defaults: {},
    edge_defaults: {},
  };
  return {
    parseWorkflowKdl: vi.fn((source: string) => {
      if (parseWorkflowKdlImpl) return parseWorkflowKdlImpl(source);
      return { version: 2, name: "wf", start: "start", goal: "test goal", stages: [{ id: "exit", kind: "exit" }] };
    }),
    workflowToGraph: vi.fn(() => graph),
    validateWorkflow: vi.fn(() => []),
    graphToDot: vi.fn(() => 'digraph "TestPipeline" {\n  start -> work\n  work -> exit\n}'),
    runPipeline: vi.fn(async (config: any) => {
      if (runPipelineImpl) return runPipelineImpl(config);
      const events: PipelineEvent[] = [
        { kind: "pipeline_started", timestamp: new Date().toISOString(), data: { name: "TestPipeline" } },
        { kind: "stage_started", timestamp: new Date().toISOString(), data: { name: "work" } },
        { kind: "stage_completed", timestamp: new Date().toISOString(), data: { name: "work" } },
        { kind: "pipeline_completed", timestamp: new Date().toISOString(), data: {} },
      ];
      for (const e of events) config.onEvent?.(e);
      return { status: "success", completedNodes: ["start", "work", "exit"], usageSummary: { stages: [], totals: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 0, cost: 0 } } };
    }),
    PiBackend: class PiBackend { constructor(_: any) {} },
    AutoApproveInterviewer: class AutoApproveInterviewer {},
  };
});

vi.mock("@mariozechner/pi-coding-agent", () => ({
  AuthStorage: class AuthStorage {},
  ModelRegistry: class ModelRegistry { constructor(_: any) {} },
}));

import attractorExtension from "./attractor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePi(): ExtensionAPI {
  return {
    registerCommand: vi.fn((name: string, opts: any) => {
      registeredCommands.set(name, opts);
    }),
    on: vi.fn(),
    registerTool: vi.fn(),
    registerShortcut: vi.fn(),
    registerFlag: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    appendEntry: vi.fn(),
    setSessionName: vi.fn(),
    getSessionName: vi.fn(),
    setLabel: vi.fn(),
    getCommands: vi.fn(() => []),
    registerMessageRenderer: vi.fn(),
    exec: vi.fn(),
    getActiveTools: vi.fn(() => []),
    getAllTools: vi.fn(() => []),
    setActiveTools: vi.fn(),
    setModel: vi.fn(),
    getThinkingLevel: vi.fn(() => "off"),
    setThinkingLevel: vi.fn(),
    events: { on: vi.fn(), emit: vi.fn() },
    registerProvider: vi.fn(),
    getFlag: vi.fn(),
  } as unknown as ExtensionAPI;
}

function makeCtx(cwd: string): ExtensionCommandContext {
  const notifyCalls: Array<{ msg: string; type?: string }> = [];
  return {
    hasUI: true,
    cwd,
    ui: {
      select: vi.fn(async () => undefined),
      confirm: vi.fn(async () => true),
      input: vi.fn(async () => ""),
      notify: vi.fn((msg: string, type?: string) => { notifyCalls.push({ msg, type }); }),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      setWorkingMessage: vi.fn(),
      setFooter: vi.fn(),
      setHeader: vi.fn(),
      setTitle: vi.fn(),
      setEditorText: vi.fn(),
      getEditorText: vi.fn(() => ""),
      editor: vi.fn(),
      custom: vi.fn(),
      theme: {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
        strikethrough: (text: string) => text,
        bg: (_color: string, text: string) => text,
        italic: (text: string) => text,
      },
      getToolsExpanded: vi.fn(() => false),
      setToolsExpanded: vi.fn(),
      setEditorComponent: vi.fn(),
      getAllThemes: vi.fn(() => []),
      getTheme: vi.fn(),
      setTheme: vi.fn(() => ({ success: true })),
    },
    sessionManager: {
      getEntries: vi.fn(() => []),
      getBranch: vi.fn(() => []),
      getLeafId: vi.fn(() => undefined),
    },
    modelRegistry: undefined,
    model: undefined,
    isIdle: vi.fn(() => true),
    abort: vi.fn(),
    hasPendingMessages: vi.fn(() => false),
    shutdown: vi.fn(),
    getContextUsage: vi.fn(),
    compact: vi.fn(),
    getSystemPrompt: vi.fn(() => ""),
    waitForIdle: vi.fn(async () => {}),
    newSession: vi.fn(async () => ({ cancelled: false })),
    fork: vi.fn(async () => ({ cancelled: false })),
    navigateTree: vi.fn(async () => ({ cancelled: false })),
    _notifyCalls: notifyCalls,
  } as unknown as ExtensionCommandContext & { _notifyCalls: typeof notifyCalls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("attractor extension", () => {
  let tempDir: string;
  let dotFile: string;

  beforeEach(async () => {
    registeredCommands.clear();
    runPipelineImpl = undefined;
    parseWorkflowKdlImpl = undefined;
    execFileMock.mockReset();
    tempDir = await mkdtemp(join(tmpdir(), "attractor-ext-test-"));
    dotFile = join(tempDir, "test.awf.kdl");
    await writeFile(dotFile, 'workflow "x" { version 2 start "exit" stage "exit" kind="exit" }');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("registers /attractor command", () => {
    const pi = makePi();
    attractorExtension(pi);
    expect(pi.registerCommand).toHaveBeenCalledWith("attractor", expect.any(Object));
  });

  it("provides argument completions", () => {
    const pi = makePi();
    attractorExtension(pi);
    const cmd = registeredCommands.get("attractor");
    expect(cmd).toBeDefined();
    const completions = cmd!.getArgumentCompletions!("r");
    expect(completions).toEqual([{ value: "run", label: "run — Execute a pipeline" }]);
  });

  it("shows error in non-interactive mode", async () => {
    const pi = makePi();
    attractorExtension(pi);
    const ctx = makeCtx(tempDir);
    (ctx as any).hasUI = false;
    const handler = registeredCommands.get("attractor")!.handler;
    await handler("run test.awf.kdl", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("interactive mode"),
      "error",
    );
  });

  it("shows error for invalid subcommand", async () => {
    const pi = makePi();
    attractorExtension(pi);
    const ctx = makeCtx(tempDir);
    const handler = registeredCommands.get("attractor")!.handler;
    await handler("deploy test.awf.kdl", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Unknown subcommand"),
      "error",
    );
  });

  describe("validate", () => {
    it("reports valid graph", async () => {
      const pi = makePi();
      attractorExtension(pi);
      const ctx = makeCtx(tempDir);
      const handler = registeredCommands.get("attractor")!.handler;
      await handler(`validate ${dotFile}`, ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Valid"),
        "info",
      );
    });
  });

  describe("show", () => {
    /** Stub execFile so graph-easy appears available and produces output. */
    function stubGraphEasyAvailable(): void {
      execFileMock.mockImplementation(
        (cmd: string, args: string[], optOrCb: unknown, maybeCb?: unknown) => {
          const cb = typeof optOrCb === "function"
            ? (optOrCb as Function)
            : (maybeCb as Function);

          if (cmd === "graph-easy" && (args as string[])[0] === "--version") {
            cb(null, "usage…", "");
            return { stdin: { write: vi.fn(), end: vi.fn() } };
          }
          if (cmd === "graph-easy" && (args as string[]).includes("--from=dot")) {
            cb(null, "┌───────┐     ┌──────┐\n│ start │ --> │ exit │\n└───────┘     └──────┘", "");
            return { stdin: { write: vi.fn(), end: vi.fn() } };
          }
          cb(new Error("unexpected call"));
          return { stdin: { write: vi.fn(), end: vi.fn() } };
        },
      );
    }

    /** Stub execFile so graph-easy is not found (ENOENT). */
    function stubGraphEasyMissing(): void {
      execFileMock.mockImplementation(
        (cmd: string, _args: string[], optOrCb: unknown, maybeCb?: unknown) => {
          const cb = typeof optOrCb === "function"
            ? (optOrCb as Function)
            : (maybeCb as Function);
          if (cmd === "graph-easy") {
            const err: NodeJS.ErrnoException = new Error("spawn graph-easy ENOENT");
            err.code = "ENOENT";
            cb(err, "", "");
            return { stdin: { write: vi.fn(), end: vi.fn() } };
          }
          cb(new Error("unexpected call"));
          return { stdin: { write: vi.fn(), end: vi.fn() } };
        },
      );
    }

    it("format=dot sends a markdown dot code block via sendMessage", async () => {
      const pi = makePi();
      attractorExtension(pi);
      const ctx = makeCtx(tempDir);
      const handler = registeredCommands.get("attractor")!.handler;

      await handler(`show ${dotFile} --format dot`, ctx);

      expect(pi.sendMessage).toHaveBeenCalledTimes(1);
      const msg = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(msg.content).toContain("```dot\n");
      expect(msg.content).toContain("digraph");
      // Should NOT have invoked graph-easy
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it("default format (boxart) falls back to dot with warning when graph-easy is missing", async () => {
      stubGraphEasyMissing();
      const pi = makePi();
      attractorExtension(pi);
      const ctx = makeCtx(tempDir);
      const handler = registeredCommands.get("attractor")!.handler;

      await handler(`show ${dotFile}`, ctx);

      // Should have warned about fallback
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("graph-easy not found"),
        "warning",
      );
      // Should send DOT output as fallback
      expect(pi.sendMessage).toHaveBeenCalledTimes(1);
      const msg = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(msg.content).toContain("```dot\n");
      expect(msg.content).toContain("digraph");
    });

    it("ascii format falls back to dot with warning when graph-easy is missing", async () => {
      stubGraphEasyMissing();
      const pi = makePi();
      attractorExtension(pi);
      const ctx = makeCtx(tempDir);
      const handler = registeredCommands.get("attractor")!.handler;

      await handler(`show ${dotFile} --format ascii`, ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("graph-easy not found"),
        "warning",
      );
      const msg = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(msg.content).toContain("```dot\n");
    });

    it("boxart format with graph-easy sends rendered output in a plain code block", async () => {
      stubGraphEasyAvailable();
      const pi = makePi();
      attractorExtension(pi);
      const ctx = makeCtx(tempDir);
      const handler = registeredCommands.get("attractor")!.handler;

      await handler(`show ${dotFile} --format boxart`, ctx);

      expect(pi.sendMessage).toHaveBeenCalledTimes(1);
      const msg = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(msg.content).toMatch(/^```\n/);
      expect(msg.content).toContain("start");
      expect(msg.content).not.toContain("```dot");
    });

    it("ascii format with graph-easy sends rendered output", async () => {
      stubGraphEasyAvailable();
      const pi = makePi();
      attractorExtension(pi);
      const ctx = makeCtx(tempDir);
      const handler = registeredCommands.get("attractor")!.handler;

      await handler(`show ${dotFile} --format ascii`, ctx);

      expect(pi.sendMessage).toHaveBeenCalledTimes(1);
      const msg = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(msg.content).toMatch(/^```\n/);
    });

    it("handles runGraphEasy error gracefully", async () => {
      // graph-easy is "available" (--help succeeds) but fails on actual conversion
      execFileMock.mockImplementation(
        (cmd: string, args: string[], optOrCb: unknown, maybeCb?: unknown) => {
          const cb = typeof optOrCb === "function"
            ? (optOrCb as Function)
            : (maybeCb as Function);

          if (cmd === "graph-easy" && (args as string[])[0] === "--version") {
            cb(null, "usage…", "");
            return { stdin: { write: vi.fn(), end: vi.fn() } };
          }
          if (cmd === "graph-easy" && (args as string[]).includes("--from=dot")) {
            cb(new Error("segfault"), "", "Segmentation fault");
            return { stdin: { write: vi.fn(), end: vi.fn() } };
          }
          cb(new Error("unexpected"));
          return { stdin: { write: vi.fn(), end: vi.fn() } };
        },
      );

      const pi = makePi();
      attractorExtension(pi);
      const ctx = makeCtx(tempDir);
      const handler = registeredCommands.get("attractor")!.handler;

      // The error should propagate — handleShow doesn't catch runGraphEasy errors,
      // but the top-level handler re-throws non-CommandParseError errors.
      await expect(
        handler(`show ${dotFile} --format boxart`, ctx),
      ).rejects.toThrow("graph-easy failed");
    });
  });

  describe("run", () => {
    it("runs pipeline and shows summary", async () => {
      const pi = makePi();
      attractorExtension(pi);
      const ctx = makeCtx(tempDir) as any;
      const handler = registeredCommands.get("attractor")!.handler;
      await handler(`run ${dotFile}`, ctx);

      // Should have received a summary notification
      const notifyCalls = ctx._notifyCalls as Array<{ msg: string; type?: string }>;
      const summaryCall = notifyCalls.find((c: any) => c.msg.includes("success"));
      expect(summaryCall).toBeDefined();
    });

    it("handles dry-run", async () => {
      const pi = makePi();
      attractorExtension(pi);
      const ctx = makeCtx(tempDir);
      const handler = registeredCommands.get("attractor")!.handler;
      await handler(`run ${dotFile} --dry-run`, ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Graph:"),
        "info",
      );
    });

    it("reports missing workflow", async () => {
      const pi = makePi();
      attractorExtension(pi);
      const ctx = makeCtx(tempDir);
      const handler = registeredCommands.get("attractor")!.handler;
      await handler("run nonexistent.awf.kdl", ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("not found"),
        "error",
      );
    });

    it("shows workflow preview before execution", async () => {
      const pi = makePi();
      attractorExtension(pi);
      const ctx = makeCtx(tempDir) as any;
      const handler = registeredCommands.get("attractor")!.handler;
      await handler(`run ${dotFile}`, ctx);

      const notifyCalls = ctx._notifyCalls as Array<{ msg: string; type?: string }>;
      const previewCall = notifyCalls.find((c: any) => c.msg.includes("Workflow:"));
      expect(previewCall).toBeDefined();
    });

    it("prompts for goal when workflow has no goal", async () => {
      // Override parseWorkflowKdl to return a workflow without goal
      parseWorkflowKdlImpl = () => ({
        version: 2,
        name: "wf",
        start: "start",
        stages: [{ id: "exit", kind: "exit" }],
        // no goal
      });

      const pi = makePi();
      attractorExtension(pi);
      const ctx = makeCtx(tempDir);
      (ctx.ui.input as any).mockResolvedValueOnce("My test goal");
      const handler = registeredCommands.get("attractor")!.handler;
      await handler(`run ${dotFile}`, ctx);

      expect(ctx.ui.input).toHaveBeenCalledWith("Enter the pipeline goal");
    });

    it("cancels when goal prompt is cancelled", async () => {
      parseWorkflowKdlImpl = () => ({
        version: 2,
        name: "wf",
        start: "start",
        stages: [{ id: "exit", kind: "exit" }],
      });

      const { runPipeline } = await import("../pipeline/index.js");
      (runPipeline as any).mockClear();
      const pi = makePi();
      attractorExtension(pi);
      const ctx = makeCtx(tempDir);
      (ctx.ui.input as any).mockResolvedValueOnce(undefined); // cancelled
      const handler = registeredCommands.get("attractor")!.handler;
      await handler(`run ${dotFile}`, ctx);

      // Pipeline should not have been called
      expect(runPipeline).not.toHaveBeenCalled();
    });

    it("skips goal prompt on --resume", async () => {
      const pi = makePi();
      attractorExtension(pi);
      const ctx = makeCtx(tempDir);
      const handler = registeredCommands.get("attractor")!.handler;
      await handler(`run ${dotFile} --resume`, ctx);

      // input should never be called for goal
      expect(ctx.ui.input).not.toHaveBeenCalled();
    });
  });

  describe("guided workflow selection", () => {
    it("run with no workflow opens picker", async () => {
      // Set up workflows directory
      const wfDir = join(tempDir, ".attractor", "workflows");
      const { mkdir, writeFile: wf } = await import("node:fs/promises");
      await mkdir(wfDir, { recursive: true });
      await wf(join(wfDir, "deploy.awf.kdl"), 'workflow "deploy" { version 2 start "exit" stage "exit" kind="exit" }');

      const pi = makePi();
      attractorExtension(pi);
      const ctx = makeCtx(tempDir);
      // Mock parser returns name "wf", so select that
      (ctx.ui.select as any).mockResolvedValueOnce("wf");
      const handler = registeredCommands.get("attractor")!.handler;
      await handler("run", ctx);

      expect(ctx.ui.select).toHaveBeenCalledWith(
        "Select a workflow",
        expect.any(Array),
      );
    });

    it("picker cancel exits without side effects", async () => {
      const wfDir = join(tempDir, ".attractor", "workflows");
      const { mkdir, writeFile: wf } = await import("node:fs/promises");
      await mkdir(wfDir, { recursive: true });
      await wf(join(wfDir, "deploy.awf.kdl"), 'workflow "deploy" { version 2 start "exit" stage "exit" kind="exit" }');

      const { runPipeline } = await import("../pipeline/index.js");
      (runPipeline as any).mockClear();
      const pi = makePi();
      attractorExtension(pi);
      const ctx = makeCtx(tempDir);
      (ctx.ui.select as any).mockResolvedValueOnce(undefined); // cancelled
      const handler = registeredCommands.get("attractor")!.handler;
      await handler("run", ctx);

      expect(runPipeline).not.toHaveBeenCalled();
    });

    it("validate with no workflow opens picker", async () => {
      const wfDir = join(tempDir, ".attractor", "workflows");
      const { mkdir, writeFile: wf } = await import("node:fs/promises");
      await mkdir(wfDir, { recursive: true });
      await wf(join(wfDir, "check.awf.kdl"), 'workflow "check" { version 2 start "exit" stage "exit" kind="exit" }');

      const pi = makePi();
      attractorExtension(pi);
      const ctx = makeCtx(tempDir);
      // Mock returns name "wf" for all parses, so select that
      (ctx.ui.select as any).mockResolvedValueOnce("wf");
      const handler = registeredCommands.get("attractor")!.handler;
      await handler("validate", ctx);

      expect(ctx.ui.select).toHaveBeenCalledWith(
        "Select a workflow",
        expect.any(Array),
      );
      // Should have shown validation result
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Valid"),
        "info",
      );
    });

    it("shows error when no workflows found", async () => {
      const pi = makePi();
      attractorExtension(pi);
      const ctx = makeCtx(tempDir);
      const handler = registeredCommands.get("attractor")!.handler;
      await handler("run", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("No workflows found"),
        "error",
      );
    });
  });
});
