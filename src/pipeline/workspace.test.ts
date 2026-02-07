/**
 * Tests for workspace handlers.
 *
 * Uses a mock jj runner to test handler logic without requiring
 * a real jj repository.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  WorkspaceCreateHandler,
  WorkspaceMergeHandler,
  WorkspaceCleanupHandler,
  emergencyWorkspaceCleanup,
  WS_CONTEXT,
  type JjRunner,
} from "./workspace.js";
import { Context } from "./types.js";
import type { GraphNode, Graph } from "./types.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGraph(name = "TestPipeline"): Graph {
  return {
    name,
    attrs: { goal: "test" },
    nodes: [],
    edges: [],
    node_defaults: {},
    edge_defaults: {},
  };
}

function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: "ws_node",
    attrs: {},
    ...overrides,
  };
}

/** Create a mock jj runner that returns canned responses. */
function mockJj(responses: Record<string, string> = {}): JjRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const runner = async (args: string[], cwd?: string): Promise<string> => {
    calls.push(args);
    // Match on first two args as the "command"
    const cmd = args.slice(0, 2).join(" ");
    if (cmd in responses) return responses[cmd];
    // Match on first arg
    if (args[0] in responses) return responses[args[0]];
    return "";
  };
  (runner as any).calls = calls;
  return runner as JjRunner & { calls: string[][] };
}

// ---------------------------------------------------------------------------
// WorkspaceCreateHandler
// ---------------------------------------------------------------------------

describe("WorkspaceCreateHandler", () => {
  it("creates a workspace and stores metadata in context", async () => {
    const jj = mockJj({
      "root": "/tmp/test-repo",
      "workspace list": "default: /tmp/test-repo",
      "log": "abc12345",
      "workspace add": "",
    });

    const logsRoot = await mkdtemp(join(tmpdir(), "ws-test-"));
    try {
      const handler = new WorkspaceCreateHandler(jj);
      const context = new Context();
      const node = makeNode({ attrs: { workspace_name: "my-feature" } });

      const outcome = await handler.execute(node, context, makeGraph(), logsRoot);

      expect(outcome.status).toBe("success");
      expect(outcome.context_updates![WS_CONTEXT.NAME]).toBe("my-feature");
      expect(outcome.context_updates![WS_CONTEXT.PATH]).toBe("/tmp/test-repo-ws-my-feature");
      expect(outcome.context_updates![WS_CONTEXT.BASE_COMMIT]).toBe("abc12345");
      expect(outcome.context_updates![WS_CONTEXT.REPO_ROOT]).toBe("/tmp/test-repo");

      // Should have called workspace add
      const addCall = jj.calls.find((c) => c[0] === "workspace" && c[1] === "add");
      expect(addCall).toBeDefined();
      expect(addCall).toContain("my-feature");
    } finally {
      await rm(logsRoot, { recursive: true, force: true });
    }
  });

  it("auto-generates workspace name from graph name", async () => {
    const jj = mockJj({
      "root": "/tmp/test-repo",
      "workspace list": "default: /tmp/test-repo",
      "log": "abc12345",
      "workspace add": "",
    });

    const logsRoot = await mkdtemp(join(tmpdir(), "ws-test-"));
    try {
      const handler = new WorkspaceCreateHandler(jj);
      const context = new Context();
      const node = makeNode(); // no workspace_name

      const outcome = await handler.execute(node, context, makeGraph("FeatureImpl"), logsRoot);

      expect(outcome.status).toBe("success");
      expect(outcome.context_updates![WS_CONTEXT.NAME]).toBe("pipeline-featureimpl");
    } finally {
      await rm(logsRoot, { recursive: true, force: true });
    }
  });

  it("fails when workspace already exists", async () => {
    const jj = mockJj({
      "root": "/tmp/test-repo",
      "workspace list": "default: /tmp/test-repo\nmy-feature: /tmp/test-repo-ws-my-feature",
      "log": "abc12345",
    });

    const logsRoot = await mkdtemp(join(tmpdir(), "ws-test-"));
    try {
      const handler = new WorkspaceCreateHandler(jj);
      const context = new Context();
      const node = makeNode({ attrs: { workspace_name: "my-feature" } });

      const outcome = await handler.execute(node, context, makeGraph(), logsRoot);

      expect(outcome.status).toBe("fail");
      expect(outcome.failure_reason).toContain("already exists");
    } finally {
      await rm(logsRoot, { recursive: true, force: true });
    }
  });

  it("writes workspace.json to the logs directory", async () => {
    const jj = mockJj({
      "root": "/tmp/test-repo",
      "workspace list": "default: /tmp/test-repo",
      "log": "abc12345",
      "workspace add": "",
    });

    const logsRoot = await mkdtemp(join(tmpdir(), "ws-test-"));
    try {
      const handler = new WorkspaceCreateHandler(jj);
      const context = new Context();
      const node = makeNode({ id: "setup", attrs: { workspace_name: "log-test" } });

      await handler.execute(node, context, makeGraph(), logsRoot);

      const logFile = JSON.parse(await readFile(join(logsRoot, "setup", "workspace.json"), "utf-8"));
      expect(logFile.name).toBe("log-test");
      expect(logFile.base_commit).toBe("abc12345");
    } finally {
      await rm(logsRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// WorkspaceMergeHandler
// ---------------------------------------------------------------------------

describe("WorkspaceMergeHandler", () => {
  function contextWithWorkspace(): Context {
    const ctx = new Context();
    ctx.set(WS_CONTEXT.NAME, "my-feature");
    ctx.set(WS_CONTEXT.PATH, "/tmp/test-repo-ws-my-feature");
    ctx.set(WS_CONTEXT.REPO_ROOT, "/tmp/test-repo");
    ctx.set(WS_CONTEXT.BASE_COMMIT, "abc12345");
    return ctx;
  }

  it("rebases workspace commits onto default", async () => {
    const jj = mockJj({
      "log": "commit3\ncommit2\ncommit1",
      "rebase": "",
    });

    const logsRoot = await mkdtemp(join(tmpdir(), "ws-test-"));
    try {
      const handler = new WorkspaceMergeHandler(jj);
      const context = contextWithWorkspace();
      const node = makeNode({ id: "merge" });

      const outcome = await handler.execute(node, context, makeGraph(), logsRoot);

      expect(outcome.status).toBe("success");
      expect(outcome.notes).toContain("3 commit(s)");
      expect(outcome.context_updates![WS_CONTEXT.MERGED]).toBe("true");

      // Should have called rebase with the earliest (last) commit
      const rebaseCall = jj.calls.find((c) => c[0] === "rebase");
      expect(rebaseCall).toBeDefined();
      expect(rebaseCall).toContain("commit1");
    } finally {
      await rm(logsRoot, { recursive: true, force: true });
    }
  });

  it("succeeds with no commits to merge", async () => {
    const jj = mockJj({
      "log": "",
    });

    const logsRoot = await mkdtemp(join(tmpdir(), "ws-test-"));
    try {
      const handler = new WorkspaceMergeHandler(jj);
      const context = contextWithWorkspace();

      const outcome = await handler.execute(makeNode(), context, makeGraph(), logsRoot);

      expect(outcome.status).toBe("success");
      expect(outcome.notes).toContain("No workspace-specific commits");
    } finally {
      await rm(logsRoot, { recursive: true, force: true });
    }
  });

  it("fails when no workspace context exists", async () => {
    const jj = mockJj();
    const logsRoot = await mkdtemp(join(tmpdir(), "ws-test-"));
    try {
      const handler = new WorkspaceMergeHandler(jj);
      const context = new Context(); // no workspace set

      const outcome = await handler.execute(makeNode(), context, makeGraph(), logsRoot);

      expect(outcome.status).toBe("fail");
      expect(outcome.failure_reason).toContain("No workspace context");
    } finally {
      await rm(logsRoot, { recursive: true, force: true });
    }
  });

  it("reports failure on rebase conflict", async () => {
    const jj = mockJj({
      "log": "commit1",
    });
    // Override rebase to throw (simulating conflict)
    const originalRunner = jj;
    const conflictJj: JjRunner & { calls: string[][] } = Object.assign(
      async (args: string[], cwd?: string) => {
        if (args[0] === "rebase") {
          throw new Error("conflict in file.ts");
        }
        return originalRunner(args, cwd);
      },
      { calls: originalRunner.calls },
    );

    const logsRoot = await mkdtemp(join(tmpdir(), "ws-test-"));
    try {
      const handler = new WorkspaceMergeHandler(conflictJj);
      const context = contextWithWorkspace();

      const outcome = await handler.execute(makeNode(), context, makeGraph(), logsRoot);

      expect(outcome.status).toBe("fail");
      expect(outcome.failure_reason).toContain("Rebase failed");
      expect(outcome.context_updates![WS_CONTEXT.MERGE_CONFLICTS]).toBe("true");
    } finally {
      await rm(logsRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// WorkspaceCleanupHandler
// ---------------------------------------------------------------------------

describe("WorkspaceCleanupHandler", () => {
  it("forgets workspace and marks cleanup complete", async () => {
    const jj = mockJj({
      "workspace forget": "",
    });

    const logsRoot = await mkdtemp(join(tmpdir(), "ws-test-"));
    try {
      const handler = new WorkspaceCleanupHandler(jj);
      const context = new Context();
      context.set(WS_CONTEXT.NAME, "my-feature");
      context.set(WS_CONTEXT.PATH, "/tmp/nonexistent-ws-my-feature");
      context.set(WS_CONTEXT.REPO_ROOT, "/tmp/test-repo");

      const outcome = await handler.execute(makeNode({ id: "cleanup" }), context, makeGraph(), logsRoot);

      expect(outcome.status).toBe("success");
      expect(outcome.context_updates![WS_CONTEXT.CLEANED_UP]).toBe("true");

      // Should have called workspace forget
      const forgetCall = jj.calls.find((c) => c[0] === "workspace" && c[1] === "forget");
      expect(forgetCall).toBeDefined();
      expect(forgetCall).toContain("my-feature");
    } finally {
      await rm(logsRoot, { recursive: true, force: true });
    }
  });

  it("refuses to clean up the default workspace", async () => {
    const jj = mockJj();
    const logsRoot = await mkdtemp(join(tmpdir(), "ws-test-"));
    try {
      const handler = new WorkspaceCleanupHandler(jj);
      const context = new Context();
      context.set(WS_CONTEXT.NAME, "default");

      const outcome = await handler.execute(makeNode(), context, makeGraph(), logsRoot);

      expect(outcome.status).toBe("fail");
      expect(outcome.failure_reason).toContain("default workspace");
    } finally {
      await rm(logsRoot, { recursive: true, force: true });
    }
  });

  it("fails when no workspace name in context", async () => {
    const jj = mockJj();
    const logsRoot = await mkdtemp(join(tmpdir(), "ws-test-"));
    try {
      const handler = new WorkspaceCleanupHandler(jj);
      const context = new Context();

      const outcome = await handler.execute(makeNode(), context, makeGraph(), logsRoot);

      expect(outcome.status).toBe("fail");
      expect(outcome.failure_reason).toContain("No workspace name");
    } finally {
      await rm(logsRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// emergencyWorkspaceCleanup
// ---------------------------------------------------------------------------

describe("emergencyWorkspaceCleanup", () => {
  it("calls workspace forget when workspace exists in context", async () => {
    const jj = mockJj({
      "workspace forget": "",
    });

    const context = new Context();
    context.set(WS_CONTEXT.NAME, "my-feature");
    context.set(WS_CONTEXT.PATH, "/tmp/nonexistent-ws-my-feature");
    context.set(WS_CONTEXT.REPO_ROOT, "/tmp/test-repo");

    await emergencyWorkspaceCleanup(context, jj);

    const forgetCall = jj.calls.find((c) => c[0] === "workspace" && c[1] === "forget");
    expect(forgetCall).toBeDefined();
  });

  it("does nothing when no workspace in context", async () => {
    const jj = mockJj();
    const context = new Context();

    await emergencyWorkspaceCleanup(context, jj);

    expect(jj.calls).toHaveLength(0);
  });

  it("does nothing when already cleaned up", async () => {
    const jj = mockJj();
    const context = new Context();
    context.set(WS_CONTEXT.NAME, "my-feature");
    context.set(WS_CONTEXT.CLEANED_UP, "true");

    await emergencyWorkspaceCleanup(context, jj);

    expect(jj.calls).toHaveLength(0);
  });

  it("does nothing for the default workspace", async () => {
    const jj = mockJj();
    const context = new Context();
    context.set(WS_CONTEXT.NAME, "default");

    await emergencyWorkspaceCleanup(context, jj);

    expect(jj.calls).toHaveLength(0);
  });

  it("swallows errors silently", async () => {
    const jj: JjRunner = async () => { throw new Error("jj not found"); };
    const context = new Context();
    context.set(WS_CONTEXT.NAME, "my-feature");
    context.set(WS_CONTEXT.REPO_ROOT, "/tmp/test-repo");

    // Should not throw
    await emergencyWorkspaceCleanup(context, jj);
  });
});

// ---------------------------------------------------------------------------
// Integration: workspace handlers resolve via HandlerRegistry
// ---------------------------------------------------------------------------

describe("HandlerRegistry workspace integration", () => {
  it("resolves workspace.create, workspace.merge, workspace.cleanup types", async () => {
    // Import here to avoid circular deps in test setup
    const { HandlerRegistry } = await import("./handlers.js");
    const jj = mockJj();

    const registry = new HandlerRegistry({ jjRunner: jj });

    const createNode: GraphNode = { id: "ws", attrs: { type: "workspace.create" } };
    const mergeNode: GraphNode = { id: "ws", attrs: { type: "workspace.merge" } };
    const cleanupNode: GraphNode = { id: "ws", attrs: { type: "workspace.cleanup" } };

    expect(registry.resolve(createNode)).toBeInstanceOf(WorkspaceCreateHandler);
    expect(registry.resolve(mergeNode)).toBeInstanceOf(WorkspaceMergeHandler);
    expect(registry.resolve(cleanupNode)).toBeInstanceOf(WorkspaceCleanupHandler);
  });
});
