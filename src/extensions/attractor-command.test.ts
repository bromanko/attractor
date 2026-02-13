import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseCommand,
  resolveWorkflowPath,
  tokenize,
  usageText,
  CommandParseError,
} from "./attractor-command.js";

describe("tokenize", () => {
  it("splits simple tokens", () => {
    expect(tokenize("run my-workflow --goal foo")).toEqual([
      "run", "my-workflow", "--goal", "foo",
    ]);
  });

  it("preserves quoted strings", () => {
    expect(tokenize('run wf --goal "implement the feature"')).toEqual([
      "run", "wf", "--goal", "implement the feature",
    ]);
  });

  it("handles empty input", () => {
    expect(tokenize("")).toEqual([]);
  });

  it("handles multiple spaces", () => {
    expect(tokenize("  run   wf  ")).toEqual(["run", "wf"]);
  });
});

describe("resolveWorkflowPath", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "attractor-cmd-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("resolves a direct file path", async () => {
    const dotFile = join(tempDir, "pipeline.dot");
    await writeFile(dotFile, "digraph {}");
    expect(resolveWorkflowPath(tempDir, "pipeline.dot")).toBe(dotFile);
  });

  it("resolves a bare name to .attractor/workflows/<name>.awf.kdl first", async () => {
    const wfDir = join(tempDir, ".attractor", "workflows");
    await mkdir(wfDir, { recursive: true });
    const kdlFile = join(wfDir, "deploy.awf.kdl");
    await writeFile(kdlFile, "workflow \"x\" { version 2 start \"exit\" stage \"exit\" kind=\"exit\" }");

    expect(resolveWorkflowPath(tempDir, "deploy")).toBe(kdlFile);
  });

  it("falls back to .attractor/workflows/<name>.dot", async () => {
    const wfDir = join(tempDir, ".attractor", "workflows");
    await mkdir(wfDir, { recursive: true });
    const dotFile = join(wfDir, "deploy.dot");
    await writeFile(dotFile, "digraph {}");

    expect(resolveWorkflowPath(tempDir, "deploy")).toBe(dotFile);
  });

  it("throws CommandParseError for missing bare name", () => {
    expect(() => resolveWorkflowPath(tempDir, "nope")).toThrow(CommandParseError);
    expect(() => resolveWorkflowPath(tempDir, "nope")).toThrow(/not found/);
  });

  it("throws CommandParseError for missing file path", () => {
    expect(() => resolveWorkflowPath(tempDir, "missing.dot")).toThrow(CommandParseError);
  });
});

describe("parseCommand", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "attractor-cmd-test-"));
    await writeFile(join(tempDir, "test.dot"), "digraph {}");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("parses validate subcommand", () => {
    const parsed = parseCommand("validate test.dot", tempDir);
    expect(parsed.subcommand).toBe("validate");
    expect(parsed.workflowPath).toBe(join(tempDir, "test.dot"));
  });

  it("parses run subcommand with flags", () => {
    const parsed = parseCommand(
      'run test.dot --goal "implement feature" --approve-all --dry-run',
      tempDir,
    );
    expect(parsed.subcommand).toBe("run");
    if (parsed.subcommand === "run") {
      expect(parsed.goal).toBe("implement feature");
      expect(parsed.approveAll).toBe(true);
      expect(parsed.dryRun).toBe(true);
      expect(parsed.resume).toBe(false);
    }
  });

  it("parses run with --resume flag", () => {
    const parsed = parseCommand("run test.dot --resume", tempDir);
    if (parsed.subcommand === "run") {
      expect(parsed.resume).toBe(true);
    }
  });

  it("parses run with --logs and --tools", () => {
    const parsed = parseCommand("run test.dot --logs /tmp/logs --tools read-only", tempDir);
    if (parsed.subcommand === "run") {
      expect(parsed.logs).toBe("/tmp/logs");
      expect(parsed.tools).toBe("read-only");
    }
  });

  it("throws on empty input", () => {
    expect(() => parseCommand("", tempDir)).toThrow(CommandParseError);
  });

  it("throws on unknown subcommand", () => {
    expect(() => parseCommand("deploy test.dot", tempDir)).toThrow(CommandParseError);
    expect(() => parseCommand("deploy test.dot", tempDir)).toThrow(/Unknown subcommand/);
  });

  it("throws on missing workflow", () => {
    expect(() => parseCommand("run", tempDir)).toThrow(CommandParseError);
    expect(() => parseCommand("run", tempDir)).toThrow(/Missing workflow/);
  });

  it("throws on invalid --tools value", () => {
    expect(() => parseCommand("run test.dot --tools garbage", tempDir)).toThrow(CommandParseError);
    expect(() => parseCommand("run test.dot --tools garbage", tempDir)).toThrow(/Invalid --tools value/);
  });

  it("accepts valid --tools values", () => {
    for (const mode of ["none", "read-only", "coding"]) {
      const parsed = parseCommand(`run test.dot --tools ${mode}`, tempDir);
      if (parsed.subcommand === "run") {
        expect(parsed.tools).toBe(mode);
      }
    }
  });
});

describe("usageText", () => {
  it("includes run and validate", () => {
    const text = usageText();
    expect(text).toContain("/attractor run");
    expect(text).toContain("/attractor validate");
  });
});
