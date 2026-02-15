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
 * Usage:
 *   stage "setup" kind="tool" type="workspace.create" workspace_name="my-feature"
 *   stage "merge" kind="tool" type="workspace.merge"
 *   stage "clean" kind="tool" type="workspace.cleanup"
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
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
  } catch (_err) {
    // Registry file may not exist yet — return empty registry
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

/** Valid jj workspace name: alphanumeric, dashes, and underscores. */
const VALID_WORKSPACE_NAME = /^[a-zA-Z0-9_-]+$/;

export function parseWorkspaceNames(workspaceListOutput: string): Set<string> {
  const names = new Set<string>();
  for (const line of workspaceListOutput.split("\n")) {
    const name = line.trim();
    if (!name) continue;
    if (VALID_WORKSPACE_NAME.test(name)) {
      names.add(name);
    }
  }
  return names;
}

/** Fallback used when an input sanitizes to an empty string (e.g., all special characters). */
export const DEFAULT_WORKSPACE_PART = "pipeline";

export function sanitizeWorkspaceNamePart(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-{2,}/g, "-");

  // Fall back to DEFAULT_WORKSPACE_PART when the entire input is
  // non-alphanumeric and the slug ends up empty after sanitization.
  return slug.slice(0, 48).replace(/-+$/, "") || DEFAULT_WORKSPACE_PART;
}

export function uniquifyWorkspaceName(base: string, existingNames: Set<string>, alwaysSuffix = false): string {
  const runSuffix = randomBytes(4).toString("hex");

  const MAX_ATTEMPTS = 1000;
  let candidate = alwaysSuffix || existingNames.has(base) ? `${base}-${runSuffix}` : base;
  let i = 2;
  while (existingNames.has(candidate)) {
    if (i > MAX_ATTEMPTS) {
      throw new Error(`Could not generate unique workspace name after ${MAX_ATTEMPTS} attempts (base: "${base}")`);
    }
    candidate = `${base}-${runSuffix}-${i}`;
    i += 1;
  }

  return candidate;
}

function generateUniqueWorkspaceName(graphName: string, existingNames: Set<string>): string {
  const base = `pipeline-${sanitizeWorkspaceNamePart(graphName)}`;
  return uniquifyWorkspaceName(base, existingNames, true);
}

/**
 * Normalize and validate a revision token before embedding into a revset.
 * Accepts "@" or short alphanumeric commit/change IDs.
 */
function normalizeRevisionToken(revision: string): string {
  const normalized = revision.trim();
  if (normalized === "@") return normalized;
  if (!/^[a-z0-9]+$/i.test(normalized)) {
    throw new Error(`Invalid revision token format: ${JSON.stringify(revision)}`);
  }
  return normalized;
}

/**
 * Build a revset for merged heads using a validated revision token.
 */
export function buildMergedHeadsRevset(defaultHeadBeforeMerge: string): { head: string; revset: string } {
  const head = normalizeRevisionToken(defaultHeadBeforeMerge);
  return {
    head,
    revset: `heads(descendants(${head}) & mutable() & ~${head})`,
  };
}

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

    const existingList = await jj(["workspace", "list", "-T", "name ++ \"\\n\""]);
    const existingNames = parseWorkspaceNames(existingList);

    // Resolve workspace name and create, retrying on name collisions
    // caused by concurrent workspace creation (TOCTOU race).
    const MAX_CREATE_RETRIES = 3;
    const rawName = node.attrs.workspace_name;
    const configuredName = typeof rawName === "string"
      ? sanitizeWorkspaceNamePart(rawName)
      : undefined;
    let currentNames = existingNames;
    let name = "";
    let wsPath = "";

    for (let attempt = 0; attempt <= MAX_CREATE_RETRIES; attempt++) {
      name =
        configuredName && configuredName.length > 0
          ? uniquifyWorkspaceName(configuredName, currentNames)
          : generateUniqueWorkspaceName(graph.name, currentNames);

      wsPath = join(dirname(repoRoot), `${repoName}-ws-${name}`);

      try {
        await jj(["workspace", "add", "--name", name, wsPath]);
        break; // success
      } catch (err) {
        const errStr = String(err).toLowerCase();
        const isCollision = errStr.includes("already exists") || errStr.includes("already a workspace");

        if (isCollision && attempt < MAX_CREATE_RETRIES) {
          // Re-read workspace list to get current state and retry
          const refreshedList = await jj(["workspace", "list", "-T", "name ++ \"\\n\""]);
          currentNames = parseWorkspaceNames(refreshedList);
          continue;
        }

        return {
          status: "fail",
          failure_reason: isCollision
            ? `Workspace name collision persisted after ${MAX_CREATE_RETRIES} retries: ${err}`
            : `Failed to create workspace: ${err}`,
        };
      }
    }

    // Record current commit as the merge base
    const baseCommit = await jj(
      ["log", "-r", "@", "--no-graph", "-T", "change_id.short()", "--limit", "1"],
    );

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

    // Find workspace-specific commits (mutable, in workspace, not in default).
    // Use commit IDs (not change IDs) to avoid ambiguity if a change has
    // divergent revisions (e.g. qrxtstnswzns/0 and qrxtstnswzns/2).
    let commitsRaw: string;
    try {
      commitsRaw = await jj(
        [
          "log",
          "-r", `ancestors(${wsName}@) & mutable() & ~ancestors(default@)`,
          "--no-graph",
          "-T", "commit_id.short() ++ \"\\n\"",
        ],
        repoRoot,
      );
    } catch (err) {
      // Best effort: workspace may have no mutable ancestors; treat as empty
      console.warn(`[workspace] failed to list workspace commits: ${err}`);
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

    // Capture the current default workspace head before rewriting so we can
    // locate the rebased workspace tip afterwards and put @ on that line.
    // Use commit ID to avoid ambiguity across divergent revisions.
    let defaultHeadBeforeMerge = "@";
    try {
      defaultHeadBeforeMerge = (await jj(
        ["log", "-r", "@", "--no-graph", "-T", "commit_id.short()", "--limit", "1"],
        repoRoot,
      )).trim();
    } catch (err: unknown) {
      // Best effort fallback: use literal @ in revsets below.
      context.appendLog(
        `workspace.merge: failed to capture default head before merge; falling back to @ (${String(err)})`,
      );
      defaultHeadBeforeMerge = "@";
    }

    let safeDefaultHeadBeforeMerge = "@";

    // Rebase workspace commits onto the default workspace's current position.
    // Then move the default workspace's @ on top of the merged line so users
    // immediately see merged changes in their active working copy.
    let mergedTip: string | undefined;
    try {
      const output = await jj(["rebase", "-s", earliest, "-d", "@"], repoRoot);

      // Check for conflict markers in jj output
      if (/conflict/i.test(output)) {
        return {
          status: "fail",
          failure_reason: `Merge conflicts detected after rebase:\n${output}`,
          context_updates: { [WS_CONTEXT.MERGE_CONFLICTS]: "true" },
        };
      }

      // Find the tip(s) of commits that are descendants of the old default
      // head; this should include the rebased workspace line.
      const mergedHeadsQuery = buildMergedHeadsRevset(defaultHeadBeforeMerge);
      safeDefaultHeadBeforeMerge = mergedHeadsQuery.head;
      const mergedHeadsRaw = await jj(
        [
          "log",
          "-r", mergedHeadsQuery.revset,
          "--no-graph",
          "-T", "commit_id.short()",
          "--limit", "1",
        ],
        repoRoot,
      );
      mergedTip = mergedHeadsRaw
        .split("\n")
        .find((s) => s.trim().length > 0)
        ?.trim();

      if (mergedTip) {
        try {
          await jj(["rebase", "-s", "@", "-d", mergedTip], repoRoot);
        } catch (err) {
          const errStr = String(err);

          // This can happen on resume/retry when @ is already on the merged
          // line and rebasing it onto a descendant is a no-op from a user
          // perspective. Prefer placing @ directly on mergedTip and continue.
          if (/Cannot rebase .* onto descendant/i.test(errStr)) {
            context.appendLog(
              `workspace.merge: @ already on merged line; switching to merged tip (${mergedTip})`,
            );
            try {
              await jj(["edit", mergedTip], repoRoot);
            } catch (editErr) {
              context.appendLog(
                `workspace.merge: failed to edit merged tip (${mergedTip}) after descendant rebase no-op: ${String(editErr)}`,
              );
            }
          } else {
            context.appendLog(
              `workspace.merge: failed to move default workspace head onto merged tip (${mergedTip}): ${errStr}`,
            );
            return {
              status: "fail",
              failure_reason: "Merge conflicts detected while moving default workspace head. Resolve conflicts and retry.",
              context_updates: { [WS_CONTEXT.MERGE_CONFLICTS]: "true" },
            };
          }
        }
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
      JSON.stringify(
        {
          workspace: wsName,
          commits_merged: commits.length,
          commits,
          merged_tip: mergedTip ?? null,
          default_head_before_merge: safeDefaultHeadBeforeMerge,
          moved_default_head: Boolean(mergedTip),
        },
        null,
        2,
      ),
      "utf-8",
    );

    return {
      status: "success",
      notes: mergedTip
        ? `Merged ${commits.length} commit(s) from workspace "${wsName}" and moved @ onto merged tip ${mergedTip}.`
        : `Merged ${commits.length} commit(s) from workspace "${wsName}".`,
      context_updates: { [WS_CONTEXT.MERGED]: "true" },
    };
  }
}

// ---------------------------------------------------------------------------
// workspace.cleanup
// ---------------------------------------------------------------------------

/** Structured cleanup result details persisted to cleanup.json. */
export interface CleanupDetails {
  workspace: string;
  path: string | undefined;
  forgotWorkspace: boolean;
  removedDirectory: boolean;
  cleanupWarnings: string[];
}

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

    const warnings: string[] = [];
    let forgotWorkspace = false;
    let removedDirectory = false;

    // Forget workspace in jj
    try {
      await jj(["workspace", "forget", wsName], repoRoot || undefined);
      forgotWorkspace = true;
    } catch (err) {
      const errStr = String(err).toLowerCase();
      const isBenign =
        errStr.includes("no such workspace") ||
        errStr.includes("not found") ||
        errStr.includes("doesn't exist") ||
        errStr.includes("does not exist");
      if (isBenign) {
        // Already forgotten or doesn't exist — treat as success
        forgotWorkspace = true;
      } else {
        // Real infrastructure error (network, permissions, jj crash, etc.)
        forgotWorkspace = false;
        const msg = `workspace forget failed: ${err}`;
        warnings.push(msg);
        console.warn(`[workspace] ${msg}`);
      }
    }

    // Remove directory with safety checks
    if (wsPath && wsPath.includes("-ws-")) {
      // Additional safety: path must not be an ancestor of repo root
      if (!repoRoot || !repoRoot.startsWith(wsPath)) {
        try {
          await rm(wsPath, { recursive: true, force: true });
        } catch (err) {
          const msg = `Directory removal failed for ${wsPath}: ${err}`;
          warnings.push(msg);
          console.warn(`[workspace] ${msg}`);
        }

        // Verify directory is actually gone
        try {
          await stat(wsPath);
          // If stat succeeds, directory still exists
          const msg = `Directory still exists after removal attempt: ${wsPath}`;
          warnings.push(msg);
          console.warn(`[workspace] ${msg}`);
          removedDirectory = false;
        } catch (_err) {
          // stat failed → directory is gone (expected)
          removedDirectory = true;
        }
      } else {
        const msg = `Skipped directory removal: ${wsPath} is an ancestor of repo root ${repoRoot}`;
        warnings.push(msg);
        console.warn(`[workspace] ${msg}`);
      }
    } else if (wsPath) {
      const msg = `Skipped directory removal: path "${wsPath}" does not contain "-ws-" safety marker`;
      warnings.push(msg);
      console.warn(`[workspace] ${msg}`);
    }

    // Clean up registry
    if (repoRoot) {
      await removeFromRegistry(repoRoot, wsName);
    }

    // Build structured cleanup details
    const details: CleanupDetails = {
      workspace: wsName,
      path: wsPath || undefined,
      forgotWorkspace,
      removedDirectory,
      cleanupWarnings: warnings,
    };

    // Write stage log
    const stageDir = join(logsRoot, node.id);
    await mkdir(stageDir, { recursive: true });
    await writeFile(
      join(stageDir, "cleanup.json"),
      JSON.stringify(details, null, 2),
      "utf-8",
    );

    // Determine outcome status
    const isFullSuccess = forgotWorkspace && (removedDirectory || !wsPath);
    const status = isFullSuccess ? "success" : "partial_success";

    const notesParts: string[] = [];
    if (isFullSuccess) {
      notesParts.push(`Cleaned up workspace "${wsName}".`);
    } else {
      notesParts.push(`Partially cleaned up workspace "${wsName}".`);
      if (!removedDirectory && wsPath) {
        notesParts.push(`Warning: workspace directory still exists at ${wsPath}.`);
      }
      for (const w of warnings) {
        notesParts.push(`  - ${w}`);
      }
    }

    return {
      status,
      notes: notesParts.join("\n"),
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
  } catch (err) {
    // Best effort — emergency cleanup; log and continue
    console.warn(`[workspace] emergency forget failed: ${err}`);
  }

  if (wsPath && wsPath.includes("-ws-") && (!repoRoot || !repoRoot.startsWith(wsPath))) {
    try {
      await rm(wsPath, { recursive: true, force: true });
    } catch (err) {
      // Best effort — emergency cleanup; log and continue
      console.warn(`[workspace] emergency rm failed: ${err}`);
    }
  }

  if (repoRoot) {
    try {
      await removeFromRegistry(repoRoot, wsName);
    } catch (err) {
      // Best effort — emergency cleanup; log and continue
      console.warn(`[workspace] emergency registry cleanup failed: ${err}`);
    }
  }
}
