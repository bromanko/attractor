/**
 * workflow-resolution.ts — Shared workflow discovery and resolution.
 *
 * Used by both the standalone CLI and the Pi extension to discover and resolve
 * Attractor workflow files (*.awf.kdl) from known locations with deterministic
 * precedence. Deduplicates by filename stem; emits warnings for shadowed entries.
 *
 * Discovery locations (in precedence order):
 *   1. <cwd>/.attractor/workflows/
 *   2. <repo-root>/.attractor/workflows/  (when cwd differs from repo root)
 *   3. ~/.attractor/workflows/             (global user-level)
 */

import { readdir, readFile } from "node:fs/promises";
import { resolve, join, extname } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Location tier for precedence ordering. */
export type LocationTier = "project" | "repo" | "global";

/** A discovered workflow entry. */
export type WorkflowEntry = {
  /** Filename stem (e.g. "deploy" from "deploy.awf.kdl"). */
  stem: string;
  /** Workflow name from the parsed KDL. */
  name: string;
  /** Absolute path to the .awf.kdl file. */
  path: string;
  /** Optional workflow description. */
  description?: string;
  /** Number of stages in the workflow. */
  stageCount: number;
  /** Which location tier this entry was found in. */
  location: LocationTier;
};

/** Parser function accepted by discovery/resolution. */
export type WorkflowParser = (source: string) => {
  name: string;
  description?: string;
  stages: unknown[];
};

/** Options for discoverWorkflows. */
export type DiscoverOptions = {
  cwd: string;
  repoRoot?: string;
  homeDir?: string;
  parseKdl: WorkflowParser;
};

/** Result of workflow discovery. */
export type DiscoverResult = {
  entries: WorkflowEntry[];
  warnings: string[];
};

/** Options for resolveWorkflowPath. */
export type ResolveOptions = {
  cwd: string;
  ref: string;
  repoRoot?: string;
  homeDir?: string;
  parseKdl: WorkflowParser;
};

/** Result of successful workflow resolution. */
export type ResolveResult = {
  path: string;
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when a workflow reference cannot be resolved. */
export class WorkflowResolutionError extends Error {
  readonly searchedLocations: string[];

  constructor(message: string, searchedLocations: string[]) {
    super(message);
    this.name = "WorkflowResolutionError";
    this.searchedLocations = searchedLocations;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extract filename stem from an .awf.kdl filename (e.g. "deploy.awf.kdl" → "deploy"). */
function filenameStem(filename: string): string {
  // Only .awf.kdl files reach here (scanDirectory filters on this suffix)
  const AWF_KDL_SUFFIX = ".awf.kdl";
  if (filename.endsWith(AWF_KDL_SUFFIX)) {
    return filename.slice(0, -AWF_KDL_SUFFIX.length);
  }
  // Safety fallback: strip last extension
  const ext = extname(filename);
  return ext ? filename.slice(0, -ext.length) : filename;
}

/** Determine whether a ref looks like a bare name (no path separators, no extension). */
function isBareRef(ref: string): boolean {
  return !ref.includes("/") && !ref.includes("\\") && extname(ref) === "";
}

/** Build the list of search directories in precedence order, deduplicating identical paths. */
function searchDirs(opts: { cwd: string; repoRoot?: string; homeDir?: string }): Array<{ dir: string; tier: LocationTier }> {
  const cwdDir = resolve(opts.cwd, ".attractor", "workflows");
  const dirs: Array<{ dir: string; tier: LocationTier }> = [
    { dir: cwdDir, tier: "project" },
  ];

  if (opts.repoRoot) {
    const repoDir = resolve(opts.repoRoot, ".attractor", "workflows");
    if (repoDir !== cwdDir) {
      dirs.push({ dir: repoDir, tier: "repo" });
    }
  }

  const home = opts.homeDir ?? homedir();
  const globalDir = resolve(home, ".attractor", "workflows");
  // Avoid duplicating if homedir matches cwd or repo
  if (!dirs.some((d) => d.dir === globalDir)) {
    dirs.push({ dir: globalDir, tier: "global" });
  }

  return dirs;
}

/** Scan a single directory for *.awf.kdl files and parse them. */
async function scanDirectory(
  dir: string,
  tier: LocationTier,
  parseKdl: WorkflowParser,
): Promise<{ entries: WorkflowEntry[]; warnings: string[] }> {
  const entries: WorkflowEntry[] = [];
  const warnings: string[] = [];

  let files: string[];
  try {
    files = await readdir(dir);
  } catch (_err) {
    // Directory doesn't exist or is inaccessible — treated as empty
    return { entries, warnings };
  }

  const kdlFiles = files.filter((f) => f.endsWith(".awf.kdl")).sort();

  for (const file of kdlFiles) {
    const filePath = join(dir, file);
    try {
      const source = await readFile(filePath, "utf-8");
      const workflow = parseKdl(source);
      entries.push({
        stem: filenameStem(file),
        name: workflow.name,
        path: filePath,
        description: workflow.description,
        stageCount: workflow.stages.length,
        location: tier,
      });
    } catch (err) {
      warnings.push(
        `Failed to parse ${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { entries, warnings };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover workflow files from known Attractor locations.
 *
 * Returns a deduplicated, sorted list of workflow entries and any warnings
 * (parse failures, shadowed duplicates).
 *
 * Discovery locations (in precedence order):
 *   1. <cwd>/.attractor/workflows/
 *   2. <repo-root>/.attractor/workflows/  (skipped when cwd == repo-root)
 *   3. ~/.attractor/workflows/
 */
export async function discoverWorkflows(opts: DiscoverOptions): Promise<DiscoverResult> {
  const dirs = searchDirs(opts);
  const allEntries: WorkflowEntry[] = [];
  const allWarnings: string[] = [];

  for (const { dir, tier } of dirs) {
    const { entries, warnings } = await scanDirectory(dir, tier, opts.parseKdl);
    allEntries.push(...entries);
    allWarnings.push(...warnings);
  }

  // Deduplicate by filename stem — first by precedence wins
  const seen = new Map<string, WorkflowEntry>();
  const deduplicated: WorkflowEntry[] = [];

  for (const entry of allEntries) {
    const existing = seen.get(entry.stem);
    if (existing) {
      allWarnings.push(
        `Workflow "${entry.stem}" at ${entry.path} is shadowed by ${existing.path} (higher precedence).`,
      );
    } else {
      seen.set(entry.stem, entry);
      deduplicated.push(entry);
    }
  }

  // Sort by stem for deterministic order
  deduplicated.sort((a, b) => a.stem.localeCompare(b.stem));

  return { entries: deduplicated, warnings: allWarnings };
}

/**
 * Resolve a workflow reference to an absolute file path.
 *
 * Resolution order:
 *   1. Explicit path (absolute or relative to cwd) — resolved directly if the file exists.
 *   2. Bare name (no path separators, no extension) — resolved via discovery catalog by filename stem.
 *   3. Throws WorkflowResolutionError with searched locations.
 */
export async function resolveWorkflowPath(opts: ResolveOptions): Promise<ResolveResult> {
  const { cwd, ref } = opts;

  // 1. Explicit path resolution — no discovery needed
  if (!isBareRef(ref)) {
    const direct = resolve(cwd, ref);
    if (existsSync(direct)) {
      return { path: direct, warnings: [] };
    }
    throw new WorkflowResolutionError(
      `Workflow file not found: ${direct}\n` +
      `Provide a valid path to a .awf.kdl workflow file.`,
      [direct],
    );
  }

  // 2. Bare name — discover and match by stem
  const { entries, warnings } = await discoverWorkflows(opts);

  const match = entries.find((e) => e.stem === ref);
  if (match) {
    return { path: match.path, warnings };
  }

  // 3. Not found — build helpful error
  const dirs = searchDirs(opts);
  const searchedPaths = dirs.map((d) => join(d.dir, `${ref}.awf.kdl`));

  throw new WorkflowResolutionError(
    `Workflow "${ref}" not found.\n` +
    `Searched:\n` +
    searchedPaths.map((p) => `  ${p}`).join("\n") + "\n" +
    `Place workflow files in .attractor/workflows/ or provide a full path.`,
    searchedPaths,
  );
}
