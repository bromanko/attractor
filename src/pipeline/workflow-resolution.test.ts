import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverWorkflows,
  resolveWorkflowPath,
  WorkflowResolutionError,
  type WorkflowParser,
} from "./workflow-resolution.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MINIMAL_KDL = 'workflow "x" { version 2 start "exit" stage "exit" kind="exit" }';

function makeParser(
  results: Record<string, { name: string; description?: string; stages: unknown[] }>,
): WorkflowParser {
  return (source: string) => {
    for (const [key, value] of Object.entries(results)) {
      if (source.includes(key)) return value;
    }
    return { name: "unknown", stages: [] };
  };
}

const failingParser: WorkflowParser = () => {
  throw new Error("parse failed");
};

// ---------------------------------------------------------------------------
// Discovery tests
// ---------------------------------------------------------------------------

describe("discoverWorkflows", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "attractor-resolution-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns empty when no known dirs exist", async () => {
    const result = await discoverWorkflows({
      cwd: tempDir,
      parseKdl: makeParser({}),
    });
    expect(result.entries).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("discovers only *.awf.kdl files", async () => {
    const wfDir = join(tempDir, ".attractor", "workflows");
    await mkdir(wfDir, { recursive: true });
    await writeFile(join(wfDir, "deploy.awf.kdl"), MINIMAL_KDL);
    await writeFile(join(wfDir, "readme.md"), "# Hello");
    await writeFile(join(wfDir, "notes.txt"), "notes");

    const result = await discoverWorkflows({
      cwd: tempDir,
      parseKdl: makeParser({ x: { name: "deploy", stages: [{}] } }),
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.stem).toBe("deploy");
  });

  it("skips parse-failing files with warnings", async () => {
    const wfDir = join(tempDir, ".attractor", "workflows");
    await mkdir(wfDir, { recursive: true });
    await writeFile(join(wfDir, "bad.awf.kdl"), "not valid");

    const result = await discoverWorkflows({
      cwd: tempDir,
      parseKdl: failingParser,
    });
    expect(result.entries).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("bad.awf.kdl");
    expect(result.warnings[0]).toContain("parse failed");
  });

  it("discovers from cwd/.attractor/workflows", async () => {
    const wfDir = join(tempDir, ".attractor", "workflows");
    await mkdir(wfDir, { recursive: true });
    await writeFile(join(wfDir, "deploy.awf.kdl"), MINIMAL_KDL);

    const result = await discoverWorkflows({
      cwd: tempDir,
      parseKdl: makeParser({ x: { name: "deploy", stages: [{}] } }),
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.path).toBe(join(wfDir, "deploy.awf.kdl"));
    expect(result.entries[0]!.location).toBe("project");
  });

  it("discovers from repo-root/.attractor/workflows when cwd differs", async () => {
    // Simulate nested subdir
    const repoRoot = tempDir;
    const subDir = join(repoRoot, "packages", "frontend");
    await mkdir(subDir, { recursive: true });
    const wfDir = join(repoRoot, ".attractor", "workflows");
    await mkdir(wfDir, { recursive: true });
    await writeFile(join(wfDir, "deploy.awf.kdl"), MINIMAL_KDL);

    const result = await discoverWorkflows({
      cwd: subDir,
      repoRoot,
      parseKdl: makeParser({ x: { name: "deploy", stages: [{}] } }),
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.location).toBe("repo");
  });

  it("discovers from global ~/.attractor/workflows", async () => {
    const globalHome = join(tempDir, "fakehome");
    const globalWfDir = join(globalHome, ".attractor", "workflows");
    await mkdir(globalWfDir, { recursive: true });
    await writeFile(join(globalWfDir, "global-wf.awf.kdl"), MINIMAL_KDL);

    const result = await discoverWorkflows({
      cwd: tempDir,
      homeDir: globalHome,
      parseKdl: makeParser({ x: { name: "global-wf", stages: [{}] } }),
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.location).toBe("global");
  });

  describe("deduplication and precedence", () => {
    it("project-local beats repo-root duplicate", async () => {
      const repoRoot = tempDir;
      const subDir = join(repoRoot, "sub");
      await mkdir(subDir, { recursive: true });

      // Same filename in both project-local (subDir) and repo-root
      const cwdWfDir = join(subDir, ".attractor", "workflows");
      const repoWfDir = join(repoRoot, ".attractor", "workflows");
      await mkdir(cwdWfDir, { recursive: true });
      await mkdir(repoWfDir, { recursive: true });
      await writeFile(join(cwdWfDir, "deploy.awf.kdl"), MINIMAL_KDL);
      await writeFile(join(repoWfDir, "deploy.awf.kdl"), MINIMAL_KDL);

      const result = await discoverWorkflows({
        cwd: subDir,
        repoRoot,
        parseKdl: makeParser({ x: { name: "deploy", stages: [{}] } }),
      });

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]!.location).toBe("project");
      expect(result.entries[0]!.path).toBe(join(cwdWfDir, "deploy.awf.kdl"));
    });

    it("project-local beats global duplicate", async () => {
      const globalHome = join(tempDir, "fakehome");
      const cwdWfDir = join(tempDir, ".attractor", "workflows");
      const globalWfDir = join(globalHome, ".attractor", "workflows");
      await mkdir(cwdWfDir, { recursive: true });
      await mkdir(globalWfDir, { recursive: true });
      await writeFile(join(cwdWfDir, "deploy.awf.kdl"), MINIMAL_KDL);
      await writeFile(join(globalWfDir, "deploy.awf.kdl"), MINIMAL_KDL);

      const result = await discoverWorkflows({
        cwd: tempDir,
        homeDir: globalHome,
        parseKdl: makeParser({ x: { name: "deploy", stages: [{}] } }),
      });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]!.location).toBe("project");
    });

    it("repo-root beats global duplicate", async () => {
      const repoRoot = tempDir;
      const subDir = join(repoRoot, "sub");
      const globalHome = join(tempDir, "fakehome");
      await mkdir(subDir, { recursive: true });
      const repoWfDir = join(repoRoot, ".attractor", "workflows");
      const globalWfDir = join(globalHome, ".attractor", "workflows");
      await mkdir(repoWfDir, { recursive: true });
      await mkdir(globalWfDir, { recursive: true });
      await writeFile(join(repoWfDir, "deploy.awf.kdl"), MINIMAL_KDL);
      await writeFile(join(globalWfDir, "deploy.awf.kdl"), MINIMAL_KDL);

      const result = await discoverWorkflows({
        cwd: subDir,
        repoRoot,
        homeDir: globalHome,
        parseKdl: makeParser({ x: { name: "deploy", stages: [{}] } }),
      });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]!.location).toBe("repo");
    });

    it("emits warning listing duplicate and chosen path", async () => {
      const globalHome = join(tempDir, "fakehome");
      const cwdWfDir = join(tempDir, ".attractor", "workflows");
      const globalWfDir = join(globalHome, ".attractor", "workflows");
      await mkdir(cwdWfDir, { recursive: true });
      await mkdir(globalWfDir, { recursive: true });
      await writeFile(join(cwdWfDir, "deploy.awf.kdl"), MINIMAL_KDL);
      await writeFile(join(globalWfDir, "deploy.awf.kdl"), MINIMAL_KDL);

      const result = await discoverWorkflows({
        cwd: tempDir,
        homeDir: globalHome,
        parseKdl: makeParser({ x: { name: "deploy", stages: [{}] } }),
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("deploy");
      expect(result.warnings[0]).toContain("shadowed");
    });

    it("deterministic order: sorted by stem within same location", async () => {
      const wfDir = join(tempDir, ".attractor", "workflows");
      await mkdir(wfDir, { recursive: true });
      await writeFile(join(wfDir, "zebra.awf.kdl"), 'workflow "zebra" {}');
      await writeFile(join(wfDir, "alpha.awf.kdl"), 'workflow "alpha" {}');
      await writeFile(join(wfDir, "middle.awf.kdl"), 'workflow "middle" {}');

      const parser = makeParser({
        zebra: { name: "zebra", stages: [{}] },
        alpha: { name: "alpha", stages: [{}] },
        middle: { name: "middle", stages: [{}] },
      });

      const result = await discoverWorkflows({
        cwd: tempDir,
        parseKdl: parser,
      });
      expect(result.entries.map((e) => e.stem)).toEqual(["alpha", "middle", "zebra"]);
    });

    it("does not deduplicate when cwd equals repoRoot", async () => {
      const wfDir = join(tempDir, ".attractor", "workflows");
      await mkdir(wfDir, { recursive: true });
      await writeFile(join(wfDir, "deploy.awf.kdl"), MINIMAL_KDL);

      const result = await discoverWorkflows({
        cwd: tempDir,
        repoRoot: tempDir,
        parseKdl: makeParser({ x: { name: "deploy", stages: [{}] } }),
      });
      // cwd == repoRoot → only one scan, no dup
      expect(result.entries).toHaveLength(1);
      expect(result.warnings).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Resolution tests
// ---------------------------------------------------------------------------

describe("resolveWorkflowPath", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "attractor-resolution-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("resolves existing relative path directly", async () => {
    const filePath = join(tempDir, "pipeline.awf.kdl");
    await writeFile(filePath, MINIMAL_KDL);

    const result = await resolveWorkflowPath({
      cwd: tempDir,
      ref: "pipeline.awf.kdl",
      parseKdl: makeParser({}),
    });
    expect(result.path).toBe(filePath);
    expect(result.warnings).toEqual([]);
  });

  it("resolves existing absolute path directly", async () => {
    const filePath = join(tempDir, "my-workflow.awf.kdl");
    await writeFile(filePath, MINIMAL_KDL);

    const result = await resolveWorkflowPath({
      cwd: tempDir,
      ref: filePath,
      parseKdl: makeParser({}),
    });
    expect(result.path).toBe(filePath);
  });

  it("resolves bare name by filename stem from project-local", async () => {
    const wfDir = join(tempDir, ".attractor", "workflows");
    await mkdir(wfDir, { recursive: true });
    const filePath = join(wfDir, "deploy.awf.kdl");
    await writeFile(filePath, MINIMAL_KDL);

    const result = await resolveWorkflowPath({
      cwd: tempDir,
      ref: "deploy",
      parseKdl: makeParser({ x: { name: "deploy", stages: [{}] } }),
    });
    expect(result.path).toBe(filePath);
  });

  it("resolves bare name from global location", async () => {
    const globalHome = join(tempDir, "fakehome");
    const globalWfDir = join(globalHome, ".attractor", "workflows");
    await mkdir(globalWfDir, { recursive: true });
    const filePath = join(globalWfDir, "deploy.awf.kdl");
    await writeFile(filePath, MINIMAL_KDL);

    const result = await resolveWorkflowPath({
      cwd: tempDir,
      ref: "deploy",
      homeDir: globalHome,
      parseKdl: makeParser({ x: { name: "deploy", stages: [{}] } }),
    });
    expect(result.path).toBe(filePath);
  });

  it("throws WorkflowResolutionError for missing bare name with searched locations", async () => {
    await expect(
      resolveWorkflowPath({
        cwd: tempDir,
        ref: "nope",
        parseKdl: makeParser({}),
      }),
    ).rejects.toThrow(WorkflowResolutionError);

    try {
      await resolveWorkflowPath({
        cwd: tempDir,
        ref: "nope",
        parseKdl: makeParser({}),
      });
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowResolutionError);
      const resErr = err as WorkflowResolutionError;
      expect(resErr.message).toContain("nope");
      expect(resErr.searchedLocations.length).toBeGreaterThan(0);
    }
  });

  it("throws WorkflowResolutionError for missing explicit path", async () => {
    await expect(
      resolveWorkflowPath({
        cwd: tempDir,
        ref: "missing.awf.kdl",
        parseKdl: makeParser({}),
      }),
    ).rejects.toThrow(WorkflowResolutionError);
  });

  it("includes duplicate warnings when bare name resolved from higher-precedence location", async () => {
    const globalHome = join(tempDir, "fakehome");
    const cwdWfDir = join(tempDir, ".attractor", "workflows");
    const globalWfDir = join(globalHome, ".attractor", "workflows");
    await mkdir(cwdWfDir, { recursive: true });
    await mkdir(globalWfDir, { recursive: true });
    await writeFile(join(cwdWfDir, "deploy.awf.kdl"), MINIMAL_KDL);
    await writeFile(join(globalWfDir, "deploy.awf.kdl"), MINIMAL_KDL);

    const result = await resolveWorkflowPath({
      cwd: tempDir,
      ref: "deploy",
      homeDir: globalHome,
      parseKdl: makeParser({ x: { name: "deploy", stages: [{}] } }),
    });
    expect(result.path).toBe(join(cwdWfDir, "deploy.awf.kdl"));
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("shadowed");
  });

  it("does not emit duplicate warnings for explicit path", async () => {
    const globalHome = join(tempDir, "fakehome");
    const cwdWfDir = join(tempDir, ".attractor", "workflows");
    const globalWfDir = join(globalHome, ".attractor", "workflows");
    await mkdir(cwdWfDir, { recursive: true });
    await mkdir(globalWfDir, { recursive: true });
    const filePath = join(cwdWfDir, "deploy.awf.kdl");
    await writeFile(filePath, MINIMAL_KDL);
    await writeFile(join(globalWfDir, "deploy.awf.kdl"), MINIMAL_KDL);

    const result = await resolveWorkflowPath({
      cwd: tempDir,
      ref: filePath,
      homeDir: globalHome,
      parseKdl: makeParser({ x: { name: "deploy", stages: [{}] } }),
    });
    expect(result.path).toBe(filePath);
    expect(result.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Parity: CLI and extension use the same module
// ---------------------------------------------------------------------------

describe("parity", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "attractor-parity-test-"));
    const wfDir = join(tempDir, ".attractor", "workflows");
    await mkdir(wfDir, { recursive: true });
    await writeFile(join(wfDir, "deploy.awf.kdl"), MINIMAL_KDL);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("discoverWorkflows and resolveWorkflowPath agree on the same path", async () => {
    const parser = makeParser({ x: { name: "deploy", stages: [{}] } });

    const discovered = await discoverWorkflows({ cwd: tempDir, parseKdl: parser });
    const resolved = await resolveWorkflowPath({ cwd: tempDir, ref: "deploy", parseKdl: parser });

    expect(discovered.entries).toHaveLength(1);
    expect(resolved.path).toBe(discovered.entries[0]!.path);
  });
});
