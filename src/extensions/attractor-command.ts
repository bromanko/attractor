/**
 * attractor-command.ts — Argument parsing and workflow resolution for /attractor.
 *
 * Parses subcommands (`run`, `validate`) and their flags, and resolves
 * workflow file paths using the local `.attractor/workflows/` convention.
 */

import { existsSync } from "node:fs";
import { resolve, extname } from "node:path";

const VALID_SHOW_FORMATS: ReadonlySet<string> = new Set(["ascii", "boxart", "dot"]);
const VALID_TOOL_MODES: ReadonlySet<string> = new Set(["none", "read-only", "coding"]);

// ---------------------------------------------------------------------------
// Parsed command types
// ---------------------------------------------------------------------------

export type Subcommand = "run" | "validate" | "show";

export type ParsedRunCommand = {
  subcommand: "run";
  workflowPath?: string;
  resume: boolean;
  approveAll: boolean;
  logs?: string;
  tools?: string;
  dryRun: boolean;
};

export type ParsedValidateCommand = {
  subcommand: "validate";
  workflowPath?: string;
};

export type ShowFormat = "ascii" | "boxart" | "dot";

export type ParsedShowCommand = {
  subcommand: "show";
  workflowPath: string;
  format?: ShowFormat;
};

export type ParsedCommand = ParsedRunCommand | ParsedValidateCommand | ParsedShowCommand;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CommandParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandParseError";
  }
}

// ---------------------------------------------------------------------------
// Usage text
// ---------------------------------------------------------------------------

export function usageText(): string {
  return [
    "Usage:",
    "  /attractor run [<workflow>] [options]",
    "  /attractor validate [<workflow>]",
    "  /attractor show <workflow> [--format ascii|boxart|dot]",
    "",
    "Run options:",
    "  --resume            Resume from last checkpoint",
    "  --approve-all       Auto-approve all human gates",
    "  --logs <dir>        Logs directory (default: .attractor/logs)",
    "  --tools <mode>      Tool mode: none | read-only | coding",
    "  --dry-run           Validate and print graph without executing",
    "",
    "Show options:",
    "  --format <fmt>      Output format: ascii | boxart | dot (default: boxart)",
    "                      Falls back to dot if graph-easy is not installed",
    "",
    "When <workflow> is omitted for run/validate, an interactive picker is shown.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Workflow resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a workflow reference to an absolute file path.
 *
 * Resolution order:
 * 1. If the value is an existing file path (absolute or relative), use it directly.
 * 2. If it looks like a bare name (no path separators, no extension),
 *    look in `.attractor/workflows/<name>.awf.kdl`.
 * 3. Return an error with actionable guidance.
 */
export function resolveWorkflowPath(
  cwd: string,
  ref: string,
): string {
  // 1. Direct file reference
  const direct = resolve(cwd, ref);
  if (existsSync(direct)) return direct;

  // 2. Bare name → .attractor/workflows/<name>.awf.kdl
  const isBare = !ref.includes("/") && !ref.includes("\\") && extname(ref) === "";
  if (isBare) {
    const workflowPath = resolve(cwd, ".attractor", "workflows", `${ref}.awf.kdl`);
    if (existsSync(workflowPath)) return workflowPath;

    throw new CommandParseError(
      `Workflow "${ref}" not found.\n` +
      `Searched:\n` +
      `  ${direct}\n` +
      `  ${workflowPath}\n` +
      `Place workflow files in .attractor/workflows/ or provide a full path.`,
    );
  }

  throw new CommandParseError(
    `Workflow file not found: ${direct}\n` +
    `Provide a valid path to a .awf.kdl workflow file.`,
  );
}

// ---------------------------------------------------------------------------
// Workflow discovery
// ---------------------------------------------------------------------------

export type WorkflowCatalogEntry = {
  name: string;
  path: string;
  description?: string;
  stageCount: number;
};

/**
 * Discover workflow files from `.attractor/workflows/*.awf.kdl` in the given
 * directory. Returns a sorted list of catalog entries. Files that fail to parse
 * are skipped (returned as warnings).
 */
export async function discoverWorkflows(
  cwd: string,
  parseKdl: (source: string) => { name: string; description?: string; stages: unknown[] },
): Promise<{ entries: WorkflowCatalogEntry[]; warnings: string[] }> {
  const { readdir, readFile } = await import("node:fs/promises");
  const { resolve: resolvePath, join: joinPath } = await import("node:path");

  const workflowDir = resolvePath(cwd, ".attractor", "workflows");
  const warnings: string[] = [];
  const entries: WorkflowCatalogEntry[] = [];

  let files: string[];
  try {
    files = await readdir(workflowDir);
  } catch {
    return { entries: [], warnings: [] };
  }

  const kdlFiles = files.filter((f) => f.endsWith(".awf.kdl")).sort();

  for (const file of kdlFiles) {
    const filePath = joinPath(workflowDir, file);
    try {
      const source = await readFile(filePath, "utf-8");
      const workflow = parseKdl(source);
      entries.push({
        name: workflow.name,
        path: filePath,
        description: workflow.description,
        stageCount: workflow.stages.length,
      });
    } catch (err) {
      warnings.push(`Failed to parse ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { entries, warnings };
}

// ---------------------------------------------------------------------------
// Argument tokenizer
// ---------------------------------------------------------------------------

/**
 * Tokenize a raw argument string into argv-like tokens.
 * Handles double-quoted strings (preserving spaces).
 */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === " " && !inQuote) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

// ---------------------------------------------------------------------------
// Main parse function
// ---------------------------------------------------------------------------

/**
 * Parse a raw argument string into a structured command.
 *
 * @param raw  The argument string after `/attractor `, e.g. `run my-workflow --goal "foo"`
 * @param cwd  Working directory for workflow resolution.
 */
export function parseCommand(raw: string, cwd: string): ParsedCommand {
  const tokens = tokenize(raw.trim());

  if (tokens.length === 0) {
    throw new CommandParseError(usageText());
  }

  const subcommand = tokens[0] as string;

  if (subcommand !== "run" && subcommand !== "validate" && subcommand !== "show") {
    throw new CommandParseError(
      `Unknown subcommand: "${subcommand}"\n\n${usageText()}`,
    );
  }

  // Find the positional (workflow reference) — first non-flag token after subcommand
  let workflowRef: string | undefined;
  const flags: Record<string, string | boolean> = {};
  let i = 1;

  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.startsWith("--")) {
      const key = tok.slice(2);
      const next = tokens[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
    } else {
      if (!workflowRef) {
        workflowRef = tok;
      }
      i += 1;
    }
  }

  const workflowPath = workflowRef ? resolveWorkflowPath(cwd, workflowRef) : undefined;

  if (subcommand === "validate") {
    return { subcommand: "validate", workflowPath };
  }

  if (subcommand === "show") {
    if (!workflowPath) {
      throw new CommandParseError(
        `Missing workflow file.\n\n${usageText()}`,
      );
    }
    if (typeof flags.format === "string" && !VALID_SHOW_FORMATS.has(flags.format)) {
      throw new CommandParseError(
        `Invalid --format value: "${flags.format}". Must be one of: ascii, boxart, dot`,
      );
    }
    return {
      subcommand: "show",
      workflowPath,
      format: typeof flags.format === "string" ? flags.format as ShowFormat : undefined,
    };
  }

  // Validate --tools value
  if (typeof flags.tools === "string" && !VALID_TOOL_MODES.has(flags.tools)) {
    throw new CommandParseError(
      `Invalid --tools value: "${flags.tools}". Must be one of: none, read-only, coding`,
    );
  }

  return {
    subcommand: "run",
    workflowPath,
    resume: flags.resume === true,
    approveAll: flags["approve-all"] === true,
    logs: typeof flags.logs === "string" ? flags.logs : undefined,
    tools: typeof flags.tools === "string" ? flags.tools : undefined,
    dryRun: flags["dry-run"] === true,
  };
}
