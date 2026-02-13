import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Mocks — must be declared before the module-under-test is imported.
// ---------------------------------------------------------------------------

// We capture the mock so tests can override `execFile` behavior per-test.
const execFileMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

vi.mock("./pipeline/index.js", async () => {
  const actual = await vi.importActual<typeof import("./pipeline/index.js")>(
    "./pipeline/index.js",
  );
  return {
    ...actual,
    // Keep real parsing / graphToDot so cmdShow exercises the full path.
  };
});

vi.mock("@mariozechner/pi-coding-agent", () => ({
  AuthStorage: class AuthStorage {},
  ModelRegistry: class ModelRegistry {
    constructor(_: unknown) {}
    getAvailable() {
      return [];
    }
  },
}));

vi.mock("./interactive-interviewer.js", () => ({
  InteractiveInterviewer: class InteractiveInterviewer {},
}));

vi.mock("./cli-renderer.js", () => ({
  renderBanner: vi.fn(() => ""),
  renderSummary: vi.fn(() => ""),
  renderResumeInfo: vi.fn(() => ""),
  renderMarkdown: vi.fn((s: string) => s),
  renderFailureSummary: vi.fn(() => ""),
  renderUsageSummary: vi.fn(() => ""),
  formatCost: vi.fn((c: number) => `$${c}`),
  formatDuration: vi.fn(() => "1ms"),
  Spinner: class Spinner {
    start = vi.fn();
    stop = vi.fn();
    isRunning = vi.fn(() => false);
  },
}));

import { cmdShow } from "./cli.js";
import { hasGraphEasy, runGraphEasy } from "./pipeline/graph-easy.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MINIMAL_WORKFLOW = `\
workflow "Viz" {
  version 2
  goal "Show test"
  start "work"

  stage "work" kind="llm" prompt="Do the work"
  stage "exit" kind="exit"

  transition from="work" to="exit"
}
`;

/** Configure execFileMock to behave like a working `graph-easy`. */
function stubGraphEasyAvailable(): void {
  execFileMock.mockImplementation(
    (cmd: string, args: string[], optOrCb: unknown, maybeCb?: unknown) => {
      const cb =
        typeof optOrCb === "function"
          ? (optOrCb as Function)
          : (maybeCb as Function);
      const argsArr = args as string[];

      if (cmd === "graph-easy" && argsArr[0] === "--version") {
        // graph-easy --help exits 0
        cb(null, "usage…", "");
        return { stdin: { write: vi.fn(), end: vi.fn() } };
      }

      if (cmd === "graph-easy" && argsArr.includes("--from=dot")) {
        // Simulate graph-easy converting DOT → ascii/boxart
        const fakeOutput = "[ascii-graph-output]";
        cb(null, fakeOutput, "");
        return { stdin: { write: vi.fn(), end: vi.fn() } };
      }

      cb(new Error("unexpected call"));
      return { stdin: { write: vi.fn(), end: vi.fn() } };
    },
  );
}

/** Configure execFileMock to behave as if `graph-easy` is not installed. */
function stubGraphEasyMissing(): void {
  execFileMock.mockImplementation(
    (cmd: string, _args: string[], optOrCb: unknown, maybeCb?: unknown) => {
      const cb =
        typeof optOrCb === "function"
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

// ---------------------------------------------------------------------------
// Tests — hasGraphEasy
// ---------------------------------------------------------------------------

describe("hasGraphEasy", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("returns true when graph-easy is installed", async () => {
    stubGraphEasyAvailable();
    expect(await hasGraphEasy()).toBe(true);
  });

  it("returns false when graph-easy is missing (ENOENT)", async () => {
    stubGraphEasyMissing();
    expect(await hasGraphEasy()).toBe(false);
  });

  it("returns true when graph-easy exits with non-zero (not ENOENT)", async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], optOrCb: unknown, maybeCb?: unknown) => {
        const cb =
          typeof optOrCb === "function"
            ? (optOrCb as Function)
            : (maybeCb as Function);
        // Non-ENOENT error (e.g. graph-easy exits 1 on --help)
        const err: NodeJS.ErrnoException = new Error("exit 1");
        err.code = "1"; // not "ENOENT"
        cb(err, "", "");
        return { stdin: { write: vi.fn(), end: vi.fn() } };
      },
    );
    expect(await hasGraphEasy()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — runGraphEasy
// ---------------------------------------------------------------------------

describe("runGraphEasy", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("pipes DOT through graph-easy and returns stdout", async () => {
    const stdinWrite = vi.fn();
    const stdinEnd = vi.fn();

    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, "┌───┐\n│ A │\n└───┘", "");
        return { stdin: { write: stdinWrite, end: stdinEnd } };
      },
    );

    const result = await runGraphEasy("digraph { A -> B }", "boxart");
    expect(result).toBe("┌───┐\n│ A │\n└───┘");
    expect(stdinWrite).toHaveBeenCalledWith("digraph { A -> B }");
    expect(stdinEnd).toHaveBeenCalled();
  });

  it("rejects when graph-easy fails", async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error("segfault"), "", "something went wrong");
        return { stdin: { write: vi.fn(), end: vi.fn() } };
      },
    );

    await expect(
      runGraphEasy("digraph { A -> B }", "ascii"),
    ).rejects.toThrow("graph-easy failed: something went wrong");
  });

  it("uses error message when stderr is empty", async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error("kaboom"), "", "");
        return { stdin: { write: vi.fn(), end: vi.fn() } };
      },
    );

    await expect(
      runGraphEasy("digraph { A -> B }", "ascii"),
    ).rejects.toThrow("graph-easy failed: kaboom");
  });

  it("rejects invalid format at runtime", async () => {
    // Force an invalid value past the type system to verify the runtime guard
    await expect(
      runGraphEasy("digraph { A -> B }", "svg" as "ascii"),
    ).rejects.toThrow("Invalid graph-easy format: svg");
    // Should NOT have spawned a process
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — cmdShow
// ---------------------------------------------------------------------------

describe("cmdShow", () => {
  let tempDir: string;
  let kdlPath: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    execFileMock.mockReset();
    tempDir = await mkdtemp(join(tmpdir(), "attractor-show-test-"));
    kdlPath = join(tempDir, "pipeline.awf.kdl");
    await writeFile(kdlPath, MINIMAL_WORKFLOW, "utf-8");
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    stderrSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as never);
  });

  afterEach(async () => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("format=dot writes DOT output to stdout", async () => {
    stubGraphEasyMissing();

    await cmdShow(kdlPath, { format: "dot" });

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const output = stdoutSpy.mock.calls[0][0] as string;
    expect(output).toContain("digraph");
    expect(output).toContain("work");
    expect(output).toContain("exit");
    // hasGraphEasy is called (cached), but graph-easy --from=dot should not be
    const conversionCalls = execFileMock.mock.calls.filter(
      (c: unknown[]) => (c[1] as string[]).includes("--from=dot"),
    );
    expect(conversionCalls).toHaveLength(0);
  });

  it("format=auto falls back to dot when graph-easy is absent", async () => {
    stubGraphEasyMissing();

    await cmdShow(kdlPath, { format: "auto" });

    const output = stdoutSpy.mock.calls[0][0] as string;
    expect(output).toContain("digraph");
  });

  it("format=auto uses boxart when graph-easy is available", async () => {
    stubGraphEasyAvailable();

    await cmdShow(kdlPath, { format: "auto" });

    const output = stdoutSpy.mock.calls[0][0] as string;
    expect(output).toBe("[ascii-graph-output]");
  });

  it("format=ascii when graph-easy is absent prints error and exits", async () => {
    stubGraphEasyMissing();

    // process.exit is mocked so execution continues into runGraphEasy which throws.
    // We catch that and verify the error/exit were called first.
    await cmdShow(kdlPath, { format: "ascii" }).catch(() => {});

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("graph-easy is not installed"),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("format=boxart when graph-easy is absent prints error and exits", async () => {
    stubGraphEasyMissing();

    await cmdShow(kdlPath, { format: "boxart" }).catch(() => {});

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("graph-easy is not installed"),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("format=boxart with graph-easy pipes through and outputs result", async () => {
    stubGraphEasyAvailable();

    await cmdShow(kdlPath, { format: "boxart" });

    const output = stdoutSpy.mock.calls[0][0] as string;
    expect(output).toBe("[ascii-graph-output]");
  });

  it("rejects non-.kdl file paths", async () => {
    const txtPath = join(tempDir, "notes.txt");
    await writeFile(txtPath, "not a workflow", "utf-8");

    await expect(cmdShow(txtPath, { format: "dot" })).rejects.toThrow(
      "Only .awf.kdl workflow files are supported.",
    );
  });

  it("rejects invalid --format value", async () => {
    await cmdShow(kdlPath, { format: "png" }).catch(() => {});

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid --format value: "png"'),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("treats --format as boolean (flag without value) as auto", async () => {
    stubGraphEasyMissing();

    await cmdShow(kdlPath, { format: true });

    // boolean → falls through to "auto" → missing graph-easy → dot
    const output = stdoutSpy.mock.calls[0][0] as string;
    expect(output).toContain("digraph");
  });

  it("default format (no --format) behaves as auto", async () => {
    stubGraphEasyMissing();

    await cmdShow(kdlPath, {});

    // auto + missing graph-easy → dot fallback
    const output = stdoutSpy.mock.calls[0][0] as string;
    expect(output).toContain("digraph");
  });
});
