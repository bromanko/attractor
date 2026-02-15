import { describe, it, expect, assert, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseCommand,
  resolveWorkflowPath,
  tokenize,
  usageText,
  discoverWorkflows,
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
    const result = await resolveWorkflowPath(tempDir, "pipeline.awf.kdl");
    expect(result.path).toBe(workflowFile);
    expect(result.warnings).toEqual([]);
  });

  it("resolves a bare name to .attractor/workflows/<name>.awf.kdl first", async () => {
    const wfDir = join(tempDir, ".attractor", "workflows");
    await mkdir(wfDir, { recursive: true });
    const kdlFile = join(wfDir, "deploy.awf.kdl");
    await writeFile(kdlFile, "workflow \"x\" { version 2 start \"exit\" stage \"exit\" kind=\"exit\" }");

    const result = await resolveWorkflowPath(tempDir, "deploy");
    expect(result.path).toBe(kdlFile);
  });

  it("resolves bare name from .attractor/workflows/<name>.awf.kdl", async () => {
    const wfDir = join(tempDir, ".attractor", "workflows");
    await mkdir(wfDir, { recursive: true });
    const workflowFile = join(wfDir, "deploy.awf.kdl");
    await writeFile(workflowFile, 'workflow "x" { version 2 start "exit" stage "exit" kind="exit" }');

    const result = await resolveWorkflowPath(tempDir, "deploy");
    expect(result.path).toBe(workflowFile);
  });

  it("throws CommandParseError for missing bare name", async () => {
    await expect(resolveWorkflowPath(tempDir, "nope")).rejects.toThrow(CommandParseError);
    await expect(resolveWorkflowPath(tempDir, "nope")).rejects.toThrow(/not found/);
  });

  it("throws CommandParseError for missing file path", async () => {
    await expect(resolveWorkflowPath(tempDir, "missing.awf.kdl")).rejects.toThrow(CommandParseError);
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

  it("parses validate subcommand", async () => {
    const parsed = await parseCommand("validate test.awf.kdl", tempDir);
    expect(parsed.subcommand).toBe("validate");
    expect(parsed.workflowPath).toBe(join(tempDir, "test.awf.kdl"));
  });

  it("parses run subcommand with flags", async () => {
    const parsed = await parseCommand(
      'run test.awf.kdl --approve-all --dry-run',
      tempDir,
    );
    expect(parsed.subcommand).toBe("run");
    if (parsed.subcommand === "run") {
      expect(parsed.approveAll).toBe(true);
      expect(parsed.dryRun).toBe(true);
      expect(parsed.resume).toBe(false);
    }
  });

  it("parses run with --resume flag", async () => {
    const parsed = await parseCommand("run test.awf.kdl --resume", tempDir);
    if (parsed.subcommand === "run") {
      expect(parsed.resume).toBe(true);
    }
  });

  it("parses run with --logs and --tools", async () => {
    const parsed = await parseCommand("run test.awf.kdl --logs /tmp/logs --tools read-only", tempDir);
    if (parsed.subcommand === "run") {
      expect(parsed.logs).toBe("/tmp/logs");
      expect(parsed.tools).toBe("read-only");
    }
  });

  it("throws on empty input", async () => {
    await expect(parseCommand("", tempDir)).rejects.toThrow(CommandParseError);
  });

  it("throws on unknown subcommand", async () => {
    await expect(parseCommand("deploy test.awf.kdl", tempDir)).rejects.toThrow(CommandParseError);
    await expect(parseCommand("deploy test.awf.kdl", tempDir)).rejects.toThrow(/Unknown subcommand/);
  });

  it("allows missing workflow for run (guided mode)", async () => {
    const parsed = await parseCommand("run", tempDir);
    expect(parsed.subcommand).toBe("run");
    if (parsed.subcommand === "run") {
      expect(parsed.workflowPath).toBeUndefined();
    }
  });

  it("allows missing workflow for validate (guided mode)", async () => {
    const parsed = await parseCommand("validate", tempDir);
    expect(parsed.subcommand).toBe("validate");
    if (parsed.subcommand === "validate") {
      expect(parsed.workflowPath).toBeUndefined();
    }
  });

  it("throws on missing workflow for show", async () => {
    await expect(parseCommand("show", tempDir)).rejects.toThrow(CommandParseError);
    await expect(parseCommand("show", tempDir)).rejects.toThrow(/Missing workflow/);
  });

  it("throws on invalid --tools value", async () => {
    await expect(parseCommand("run test.awf.kdl --tools garbage", tempDir)).rejects.toThrow(CommandParseError);
    await expect(parseCommand("run test.awf.kdl --tools garbage", tempDir)).rejects.toThrow(/Invalid --tools value/);
  });

  it("accepts valid --tools values", async () => {
    for (const mode of ["none", "read-only", "coding"]) {
      const parsed = await parseCommand(`run test.awf.kdl --tools ${mode}`, tempDir);
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

  it("parses show subcommand", async () => {
    const parsed = await parseCommand("show test.awf.kdl", tempDir);
    expect(parsed.subcommand).toBe("show");
    expect(parsed.workflowPath).toBe(join(tempDir, "test.awf.kdl"));
  });

  it("parses show with --format flag", async () => {
    const parsed = await parseCommand("show test.awf.kdl --format ascii", tempDir);
    expect(parsed.subcommand).toBe("show");
    assert(parsed.subcommand === "show");
    expect(parsed.format).toBe("ascii");
  });

  it("accepts all valid format values", async () => {
    for (const fmt of ["ascii", "boxart", "dot"]) {
      const parsed = await parseCommand(`show test.awf.kdl --format ${fmt}`, tempDir);
      assert(parsed.subcommand === "show");
      expect(parsed.format).toBe(fmt);
    }
  });

  it("defaults format to undefined when not specified", async () => {
    const parsed = await parseCommand("show test.awf.kdl", tempDir);
    assert(parsed.subcommand === "show");
    expect(parsed.format).toBeUndefined();
  });

  it("treats bare --format (no value) as unset", async () => {
    const parsed = await parseCommand("show test.awf.kdl --format", tempDir);
    assert(parsed.subcommand === "show");
    expect(parsed.format).toBeUndefined();
  });

  it("throws on invalid --format value", async () => {
    await expect(parseCommand("show test.awf.kdl --format png", tempDir)).rejects.toThrow(CommandParseError);
    await expect(parseCommand("show test.awf.kdl --format png", tempDir)).rejects.toThrow(/Invalid --format value/);
  });
});

describe("usageText", () => {
  it("includes run, validate, and show", () => {
    const text = usageText();
    expect(text).toContain("/attractor run");
    expect(text).toContain("/attractor validate");
    expect(text).toContain("/attractor show");
  });

  it("does not mention --goal", () => {
    const text = usageText();
    expect(text).not.toContain("--goal");
  });
});

describe("discoverWorkflows", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "attractor-discover-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns empty when .attractor/workflows does not exist", async () => {
    const result = await discoverWorkflows(tempDir, () => ({ name: "x", stages: [] }));
    expect(result.entries).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("discovers workflows from .attractor/workflows", async () => {
    const wfDir = join(tempDir, ".attractor", "workflows");
    await mkdir(wfDir, { recursive: true });
    await writeFile(
      join(wfDir, "deploy.awf.kdl"),
      'workflow "deploy" { version 2 start "exit" stage "exit" kind="exit" }',
    );
    await writeFile(
      join(wfDir, "build.awf.kdl"),
      'workflow "build" { version 2 description "Build the project" start "exit" stage "exit" kind="exit" }',
    );

    const mockParser = (source: string) => {
      if (source.includes("deploy")) return { name: "deploy", stages: [{ id: "exit" }] };
      return { name: "build", description: "Build the project", stages: [{ id: "exit" }] };
    };

    const result = await discoverWorkflows(tempDir, mockParser);
    expect(result.entries).toHaveLength(2);
    // Sorted by name
    expect(result.entries[0]!.name).toBe("build");
    expect(result.entries[0]!.description).toBe("Build the project");
    expect(result.entries[0]!.stageCount).toBe(1);
    expect(result.entries[1]!.name).toBe("deploy");
    expect(result.entries[1]!.description).toBeUndefined();
  });

  it("skips non-.awf.kdl files", async () => {
    const wfDir = join(tempDir, ".attractor", "workflows");
    await mkdir(wfDir, { recursive: true });
    await writeFile(join(wfDir, "readme.md"), "# Hello");
    await writeFile(
      join(wfDir, "deploy.awf.kdl"),
      'workflow "deploy" { }',
    );

    const mockParser = () => ({ name: "deploy", stages: [] });
    const result = await discoverWorkflows(tempDir, mockParser);
    expect(result.entries).toHaveLength(1);
  });

  it("reports parse failures as warnings", async () => {
    const wfDir = join(tempDir, ".attractor", "workflows");
    await mkdir(wfDir, { recursive: true });
    await writeFile(join(wfDir, "bad.awf.kdl"), "not valid kdl");

    const mockParser = () => { throw new Error("parse failed"); };
    const result = await discoverWorkflows(tempDir, mockParser);
    expect(result.entries).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("bad.awf.kdl");
    expect(result.warnings[0]).toContain("parse failed");
  });
});
