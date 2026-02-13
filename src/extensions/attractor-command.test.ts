import { describe, it, expect, assert, beforeEach, afterEach } from "vitest";
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
    const workflowFile = join(tempDir, "pipeline.awf.kdl");
    await writeFile(workflowFile, 'workflow "x" { version 2 start "exit" stage "exit" kind="exit" }');
    expect(resolveWorkflowPath(tempDir, "pipeline.awf.kdl")).toBe(workflowFile);
  });

  it("resolves a bare name to .attractor/workflows/<name>.awf.kdl first", async () => {
    const wfDir = join(tempDir, ".attractor", "workflows");
    await mkdir(wfDir, { recursive: true });
    const kdlFile = join(wfDir, "deploy.awf.kdl");
    await writeFile(kdlFile, "workflow \"x\" { version 2 start \"exit\" stage \"exit\" kind=\"exit\" }");

    expect(resolveWorkflowPath(tempDir, "deploy")).toBe(kdlFile);
  });

  it("resolves bare name from .attractor/workflows/<name>.awf.kdl", async () => {
    const wfDir = join(tempDir, ".attractor", "workflows");
    await mkdir(wfDir, { recursive: true });
    const workflowFile = join(wfDir, "deploy.awf.kdl");
    await writeFile(workflowFile, 'workflow "x" { version 2 start "exit" stage "exit" kind="exit" }');

    expect(resolveWorkflowPath(tempDir, "deploy")).toBe(workflowFile);
  });

  it("throws CommandParseError for missing bare name", () => {
    expect(() => resolveWorkflowPath(tempDir, "nope")).toThrow(CommandParseError);
    expect(() => resolveWorkflowPath(tempDir, "nope")).toThrow(/not found/);
  });

  it("throws CommandParseError for missing file path", () => {
    expect(() => resolveWorkflowPath(tempDir, "missing.awf.kdl")).toThrow(CommandParseError);
  });
});

describe("parseCommand", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "attractor-cmd-test-"));
    await writeFile(join(tempDir, "test.awf.kdl"), 'workflow "x" { version 2 start "exit" stage "exit" kind="exit" }');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("parses validate subcommand", () => {
    const parsed = parseCommand("validate test.awf.kdl", tempDir);
    expect(parsed.subcommand).toBe("validate");
    expect(parsed.workflowPath).toBe(join(tempDir, "test.awf.kdl"));
  });

  it("parses run subcommand with flags", () => {
    const parsed = parseCommand(
      'run test.awf.kdl --goal "implement feature" --approve-all --dry-run',
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
    const parsed = parseCommand("run test.awf.kdl --resume", tempDir);
    if (parsed.subcommand === "run") {
      expect(parsed.resume).toBe(true);
    }
  });

  it("parses run with --logs and --tools", () => {
    const parsed = parseCommand("run test.awf.kdl --logs /tmp/logs --tools read-only", tempDir);
    if (parsed.subcommand === "run") {
      expect(parsed.logs).toBe("/tmp/logs");
      expect(parsed.tools).toBe("read-only");
    }
  });

  it("throws on empty input", () => {
    expect(() => parseCommand("", tempDir)).toThrow(CommandParseError);
  });

  it("throws on unknown subcommand", () => {
    expect(() => parseCommand("deploy test.awf.kdl", tempDir)).toThrow(CommandParseError);
    expect(() => parseCommand("deploy test.awf.kdl", tempDir)).toThrow(/Unknown subcommand/);
  });

  it("throws on missing workflow", () => {
    expect(() => parseCommand("run", tempDir)).toThrow(CommandParseError);
    expect(() => parseCommand("run", tempDir)).toThrow(/Missing workflow/);
  });

  it("throws on invalid --tools value", () => {
    expect(() => parseCommand("run test.awf.kdl --tools garbage", tempDir)).toThrow(CommandParseError);
    expect(() => parseCommand("run test.awf.kdl --tools garbage", tempDir)).toThrow(/Invalid --tools value/);
  });

  it("accepts valid --tools values", () => {
    for (const mode of ["none", "read-only", "coding"]) {
      const parsed = parseCommand(`run test.awf.kdl --tools ${mode}`, tempDir);
      if (parsed.subcommand === "run") {
        expect(parsed.tools).toBe(mode);
      }
    }
  });
});

describe("parseCommand — show", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "attractor-cmd-test-"));
    await writeFile(join(tempDir, "test.awf.kdl"), 'workflow "x" { version 2 start "exit" stage "exit" kind="exit" }');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("parses show subcommand", () => {
    const parsed = parseCommand("show test.awf.kdl", tempDir);
    expect(parsed.subcommand).toBe("show");
    expect(parsed.workflowPath).toBe(join(tempDir, "test.awf.kdl"));
  });

  it("parses show with --format flag", () => {
    const parsed = parseCommand("show test.awf.kdl --format ascii", tempDir);
    expect(parsed.subcommand).toBe("show");
    assert(parsed.subcommand === "show");
    expect(parsed.format).toBe("ascii");
  });

  it("accepts all valid format values", () => {
    for (const fmt of ["ascii", "boxart", "dot"]) {
      const parsed = parseCommand(`show test.awf.kdl --format ${fmt}`, tempDir);
      assert(parsed.subcommand === "show");
      expect(parsed.format).toBe(fmt);
    }
  });

  it("defaults format to undefined when not specified", () => {
    const parsed = parseCommand("show test.awf.kdl", tempDir);
    assert(parsed.subcommand === "show");
    expect(parsed.format).toBeUndefined();
  });

  it("treats bare --format (no value) as unset", () => {
    const parsed = parseCommand("show test.awf.kdl --format", tempDir);
    assert(parsed.subcommand === "show");
    expect(parsed.format).toBeUndefined();
  });

  it("throws on invalid --format value", () => {
    expect(() => parseCommand("show test.awf.kdl --format png", tempDir)).toThrow(CommandParseError);
    expect(() => parseCommand("show test.awf.kdl --format png", tempDir)).toThrow(/Invalid --format value/);
  });
});

describe("usageText", () => {
  it("includes run, validate, and show", () => {
    const text = usageText();
    expect(text).toContain("/attractor run");
    expect(text).toContain("/attractor validate");
    expect(text).toContain("/attractor show");
  });
});
