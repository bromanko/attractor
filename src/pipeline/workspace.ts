/**
 * Workspace Handlers — jj workspace lifecycle management for pipelines.
 *
 * Provides three handler types:
 *   - workspace.create  — Create an isolated jj workspace for pipeline work
 *   - workspace.merge   — Rebase workspace commits back into the default workspace
 *   - workspace.cleanup — Forget the workspace and remove its directory
 *
 * Workspace metadata is stored in pipeline context under the "workspace.*" namespace
 * and persisted in a registry file at <repo-root>/.jj/workspace-registry.json.
 *
 * Usage in DOT:
 *   setup  [type="workspace.create", workspace_name="my-feature"]
 *   merge  [type="workspace.merge"]
 *   clean  [type="workspace.cleanup"]
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import type { Handler, GraphNode, Context, Graph, Outcome } from "./types.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// jj command execution
// ---------------------------------------------------------------------------

export type JjRunner = (args: string[], cwd?: string) => Promise<string>;

/** Default jj runner — executes the real `jj` binary. */
async function defaultJjRunner(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("jj", args, {
    cwd,
    timeout: 30_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  return stdout.trim();
}

// ---------------------------------------------------------------------------
// Workspace registry (stored in .jj/workspace-registry.json)
// ---------------------------------------------------------------------------

type WorkspaceRegistry = {
  workspaces: Record<string, { path: string; created: string }>;
};

async function readRegistry(repoRoot: string): Promise<WorkspaceRegistry> {
  const registryPath = join(repoRoot, ".jj", "workspace-registry.json");
  try {
    const raw = await readFile(registryPath, "utf-8");
    return JSON.parse(raw) as WorkspaceRegistry;
  } catch {
    return { workspaces: {} };
  }
}

async function writeRegistry(repoRoot: string, registry: WorkspaceRegistry): Promise<void> {
  const registryPath = join(repoRoot, ".jj", "workspace-registry.json");
  await mkdir(dirname(registryPath), { recursive: true });
  await writeFile(registryPath, JSON.stringify(registry, null, 2), "utf-8");
}

async function addToRegistry(repoRoot: string, name: string, wsPath: string): Promise<void> {
  const registry = await readRegistry(repoRoot);
  registry.workspaces[name] = {
    path: wsPath,
    created: new Date().toISOString(),
  };
  await writeRegistry(repoRoot, registry);
}

async function removeFromRegistry(repoRoot: string, name: string): Promise<void> {
  const registry = await readRegistry(repoRoot);
  delete registry.workspaces[name];
  await writeRegistry(repoRoot, registry);
}

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

/** Keys stored in pipeline context by workspace handlers. */
export const WS_CONTEXT = {
  NAME: "workspace.name",
  PATH: "workspace.path",
  REPO_ROOT: "workspace.repo_root",
  BASE_COMMIT: "workspace.base_commit",
  MERGED: "workspace.merged",
  CLEANED_UP: "workspace.cleaned_up",
  MERGE_CONFLICTS: "workspace.merge_conflicts",
} as const;

// ---------------------------------------------------------------------------
// workspace.create
// ---------------------------------------------------------------------------

export class WorkspaceCreateHandler implements Handler {
  private _jj: JjRunner;

  constructor(jj?: JjRunner) {
    this._jj = jj ?? defaultJjRunner;
  }

  async execute(
    node: GraphNode,
    context: Context,
    graph: Graph,
    logsRoot: string,
  ): Promise<Outcome> {
    const jj = this._jj;

    // Resolve repo root
    const repoRoot = await jj(["root"]);
    const repoName = basename(repoRoot);

    // Resolve workspace name
    const name =
      (node.attrs.workspace_name as string) ??
      `pipeline-${graph.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "")}`;

    const wsPath = join(dirname(repoRoot), `${repoName}-ws-${name}`);

    // Check for collisions
    const existingList = await jj(["workspace", "list"]);
    if (existingList.includes(name) && name !== "default") {
      return {
        status: "fail",
        failure_reason: `Workspace "${name}" already exists. Choose a different workspace_name.`,
      };
    }

    // Record current commit as the merge base
    const baseCommit = await jj(
      ["log", "-r", "@", "--no-graph", "-T", "change_id.short()", "--limit", "1"],
    );

    // Create workspace
    try {
      await jj(["workspace", "add", "--name", name, wsPath]);
    } catch (err) {
      return {
        status: "fail",
        failure_reason: `Failed to create workspace: ${err}`,
      };
    }

    // Update registry
    await addToRegistry(repoRoot, name, wsPath);

    // Write stage log
    const stageDir = join(logsRoot, node.id);
    await mkdir(stageDir, { recursive: true });
    await writeFile(
      join(stageDir, "workspace.json"),
      JSON.stringify({ name, path: wsPath, base_commit: baseCommit }, null, 2),
      "utf-8",
    );

    return {
      status: "success",
      notes: `Created workspace "${name}" at ${wsPath}`,
      context_updates: {
        [WS_CONTEXT.NAME]: name,
        [WS_CONTEXT.PATH]: wsPath,
        [WS_CONTEXT.BASE_COMMIT]: baseCommit,
        [WS_CONTEXT.REPO_ROOT]: repoRoot,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// workspace.merge
// ---------------------------------------------------------------------------

export class WorkspaceMergeHandler implements Handler {
  private _jj: JjRunner;

  constructor(jj?: JjRunner) {
    this._jj = jj ?? defaultJjRunner;
  }

  async execute(
    node: GraphNode,
    context: Context,
    graph: Graph,
    logsRoot: string,
  ): Promise<Outcome> {
    const jj = this._jj;
    const wsName = context.getString(WS_CONTEXT.NAME);
    const repoRoot = context.getString(WS_CONTEXT.REPO_ROOT);

    if (!wsName || !repoRoot) {
      return {
        status: "fail",
        failure_reason:
          "No workspace context found. Ensure a workspace.create node ran before workspace.merge.",
      };
    }

    // Find workspace-specific commits (mutable, in workspace, not in default)
    let commitsRaw: string;
    try {
      commitsRaw = await jj(
        [
          "log",
          "-r", `ancestors(${wsName}@) & mutable() & ~ancestors(default@)`,
          "--no-graph",
          "-T", "change_id.short() ++ \"\\n\"",
        ],
        repoRoot,
      );
    } catch {
      commitsRaw = "";
    }

    const commits = commitsRaw.split("\n").filter(Boolean);

    if (commits.length === 0) {
      return {
        status: "success",
        notes: "No workspace-specific commits to merge.",
        context_updates: { [WS_CONTEXT.MERGED]: "true" },
      };
    }

    // The oldest commit is last in the log output (log prints newest first)
    const earliest = commits[commits.length - 1];

    // Rebase workspace commits onto the default workspace's current position
    try {
      const output = await jj(["rebase", "-s", earliest, "-d", "@"], repoRoot);

      // Check for conflict markers in jj output
      if (output.toLowerCase().includes("conflict")) {
        return {
          status: "fail",
          failure_reason: `Merge conflicts detected after rebase:\n${output}`,
          context_updates: { [WS_CONTEXT.MERGE_CONFLICTS]: "true" },
        };
      }
    } catch (err) {
      const errStr = String(err);
      return {
        status: "fail",
        failure_reason: `Rebase failed: ${errStr}`,
        context_updates: { [WS_CONTEXT.MERGE_CONFLICTS]: "true" },
      };
    }

    // Write stage log
    const stageDir = join(logsRoot, node.id);
    await mkdir(stageDir, { recursive: true });
    await writeFile(
      join(stageDir, "merge.json"),
      JSON.stringify({ workspace: wsName, commits_merged: commits.length, commits }, null, 2),
      "utf-8",
    );

    return {
      status: "success",
      notes: `Merged ${commits.length} commit(s) from workspace "${wsName}".`,
      context_updates: { [WS_CONTEXT.MERGED]: "true" },
    };
  }
}

// ---------------------------------------------------------------------------
// workspace.cleanup
// ---------------------------------------------------------------------------

export class WorkspaceCleanupHandler implements Handler {
  private _jj: JjRunner;

  constructor(jj?: JjRunner) {
    this._jj = jj ?? defaultJjRunner;
  }

  async execute(
    node: GraphNode,
    context: Context,
    _graph: Graph,
    logsRoot: string,
  ): Promise<Outcome> {
    const jj = this._jj;
    const wsName = context.getString(WS_CONTEXT.NAME);
    const wsPath = context.getString(WS_CONTEXT.PATH);
    const repoRoot = context.getString(WS_CONTEXT.REPO_ROOT);

    if (!wsName) {
      return {
        status: "fail",
        failure_reason: "No workspace name in context. Was workspace.create run?",
      };
    }

    // Safety: never clean up the default workspace
    if (wsName === "default") {
      return {
        status: "fail",
        failure_reason: "Refusing to clean up the default workspace.",
      };
    }

    // Forget workspace in jj
    try {
      await jj(["workspace", "forget", wsName], repoRoot || undefined);
    } catch {
      // Already forgotten or doesn't exist — that's fine.
    }

    // Remove directory with safety checks
    if (wsPath && wsPath.includes("-ws-")) {
      // Additional safety: path must not be an ancestor of repo root
      if (!repoRoot || !repoRoot.startsWith(wsPath)) {
        try {
          await rm(wsPath, { recursive: true, force: true });
        } catch {
          // Directory may already be gone.
        }
      }
    }

    // Clean up registry
    if (repoRoot) {
      await removeFromRegistry(repoRoot, wsName);
    }

    // Write stage log
    const stageDir = join(logsRoot, node.id);
    await mkdir(stageDir, { recursive: true });
    await writeFile(
      join(stageDir, "cleanup.json"),
      JSON.stringify({ workspace: wsName, path: wsPath, cleaned: true }, null, 2),
      "utf-8",
    );

    return {
      status: "success",
      notes: `Cleaned up workspace "${wsName}".`,
      context_updates: { [WS_CONTEXT.CLEANED_UP]: "true" },
    };
  }
}

// ---------------------------------------------------------------------------
// Emergency cleanup — called by the engine on pipeline failure
// ---------------------------------------------------------------------------

/**
 * Attempt to clean up a workspace if one was created during this pipeline run.
 * Intended for use as a pipeline failure hook. Silently ignores errors.
 */
export async function emergencyWorkspaceCleanup(
  context: Context,
  jj?: JjRunner,
): Promise<void> {
  const runner = jj ?? defaultJjRunner;
  const wsName = context.getString(WS_CONTEXT.NAME);
  const wsPath = context.getString(WS_CONTEXT.PATH);
  const repoRoot = context.getString(WS_CONTEXT.REPO_ROOT);
  const alreadyCleaned = context.getString(WS_CONTEXT.CLEANED_UP);

  if (!wsName || wsName === "default" || alreadyCleaned === "true") return;

  try {
    await runner(["workspace", "forget", wsName], repoRoot || undefined);
  } catch {
    // Best effort.
  }

  if (wsPath && wsPath.includes("-ws-") && (!repoRoot || !repoRoot.startsWith(wsPath))) {
    try {
      await rm(wsPath, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }

  if (repoRoot) {
    try {
      await removeFromRegistry(repoRoot, wsName);
    } catch {
      // Best effort.
    }
  }
}
