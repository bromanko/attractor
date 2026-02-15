/**
 * attractor-command.ts — Argument parsing and workflow resolution for /attractor.
 *
 * Parses subcommands (`run`, `validate`) and their flags, and resolves
 * workflow file paths using the shared workflow-resolution module.
 */

import {
  discoverWorkflows as discoverWorkflowsShared,
  resolveWorkflowPath as resolveWorkflowPathShared,
  WorkflowResolutionError,
} from "../pipeline/workflow-resolution.js";
import type { WorkflowEntry, WorkflowParser } from "../pipeline/workflow-resolution.js";

const VALID_SHOW_FORMATS: ReadonlySet<string> = new Set(["ascii", "boxart", "dot"]);
const VALID_TOOL_MODES: ReadonlySet<string> = new Set(["none", "read-only", "coding"]);

// ---------------------------------------------------------------------------
// Parsed command types
// ---------------------------------------------------------------------------

export type Subcommand = "run" | "validate" | "show";

export type ParsedRunCommand = {
  subcommand: "run";
  workflowPath?: string;
  /** Warnings from workflow resolution (e.g. shadowed duplicates). */
  warnings: string[];
  resume: boolean;
  approveAll: boolean;
  logs?: string;
  tools?: string;
  dryRun: boolean;
};

export type ParsedValidateCommand = {
  subcommand: "validate";
  workflowPath?: string;
  /** Warnings from workflow resolution (e.g. shadowed duplicates). */
  warnings: string[];
};

export type ShowFormat = "ascii" | "boxart" | "dot";

export type ParsedShowCommand = {
  subcommand: "show";
  workflowPath: string;
  /** Warnings from workflow resolution (e.g. shadowed duplicates). */
  warnings: string[];
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
// Workflow resolution — delegates to shared module
// ---------------------------------------------------------------------------

/** Result of workflow resolution including warnings for shadowed duplicates. */
export type ResolvedWorkflow = {
  path: string;
  warnings: string[];
};

/**
 * Resolve a workflow reference to an absolute file path.
 *
 * Delegates to the shared workflow-resolution module and converts
 * WorkflowResolutionError into CommandParseError for backward compatibility
 * with the command parser's error handling.
 *
 * Returns both the resolved path and any warnings (e.g. shadowed duplicates).
 */
export async function resolveWorkflowPath(
  cwd: string,
  ref: string,
  parseKdl?: WorkflowParser,
): Promise<ResolvedWorkflow> {
  try {
    const parser = parseKdl ?? minimalParser;
    const result = await resolveWorkflowPathShared({
      cwd,
      ref,
      parseKdl: parser,
    });
    return { path: result.path, warnings: result.warnings };
  } catch (err) {
    if (err instanceof WorkflowResolutionError) {
      throw new CommandParseError(err.message);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Workflow discovery — delegates to shared module
// ---------------------------------------------------------------------------

export type WorkflowCatalogEntry = {
  name: string;
  path: string;
  description?: string;
  stageCount: number;
};

/**
 * Discover workflow files from known Attractor locations.
 *
 * Delegates to the shared workflow-resolution module and maps the result
 * to the existing WorkflowCatalogEntry format for backward compatibility.
 */
export async function discoverWorkflows(
  cwd: string,
  parseKdl: (source: string) => { name: string; description?: string; stages: unknown[] },
): Promise<{ entries: WorkflowCatalogEntry[]; warnings: string[] }> {
  const result = await discoverWorkflowsShared({ cwd, parseKdl });

  const entries: WorkflowCatalogEntry[] = result.entries.map((e: WorkflowEntry) => ({
    name: e.name,
    path: e.path,
    description: e.description,
    stageCount: e.stageCount,
  }));

  return { entries, warnings: result.warnings };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Minimal parser for resolution — only needs to satisfy the WorkflowParser
 * signature. Used when callers don't provide a real parser. Bare-name
 * resolution matches by filename stem, so the parsed content is not used.
 */
const minimalParser: WorkflowParser = (_source: string) => ({
  name: "unknown",
  stages: [],
});

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
 * @param parseKdl  Optional KDL parser for bare-name resolution.
 */
export async function parseCommand(
  raw: string,
  cwd: string,
  parseKdl?: WorkflowParser,
): Promise<ParsedCommand> {
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

  const resolved = workflowRef
    ? await resolveWorkflowPath(cwd, workflowRef, parseKdl)
    : undefined;
  const workflowPath = resolved?.path;
  const warnings = resolved?.warnings ?? [];

  if (subcommand === "validate") {
    return { subcommand: "validate", workflowPath, warnings };
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
      warnings,
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
    warnings,
    resume: flags.resume === true,
    approveAll: flags["approve-all"] === true,
    logs: typeof flags.logs === "string" ? flags.logs : undefined,
    tools: typeof flags.tools === "string" ? flags.tools : undefined,
    dryRun: flags["dry-run"] === true,
  };
}
