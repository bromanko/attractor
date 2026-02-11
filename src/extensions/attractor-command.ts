/**
 * attractor-command.ts — Argument parsing and workflow resolution for /attractor.
 *
 * Parses subcommands (`run`, `validate`) and their flags, and resolves
 * workflow file paths using the local `.attractor/workflows/` convention.
 */

import { existsSync } from "node:fs";
import { resolve, extname } from "node:path";

// ---------------------------------------------------------------------------
// Parsed command types
// ---------------------------------------------------------------------------

export type Subcommand = "run" | "validate";

export type ParsedRunCommand = {
  subcommand: "run";
  workflowPath: string;
  goal?: string;
  resume: boolean;
  approveAll: boolean;
  logs?: string;
  tools?: string;
  dryRun: boolean;
};

export type ParsedValidateCommand = {
  subcommand: "validate";
  workflowPath: string;
};

export type ParsedCommand = ParsedRunCommand | ParsedValidateCommand;

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
    "  /attractor run <workflow> --goal \"...\" [options]",
    "  /attractor validate <workflow>",
    "",
    "Run options:",
    "  --goal <text>       Pipeline goal (required unless graph has one)",
    "  --resume            Resume from last checkpoint",
    "  --approve-all       Auto-approve all human gates",
    "  --logs <dir>        Logs directory (default: .attractor/logs)",
    "  --tools <mode>      Tool mode: none | read-only | coding",
    "  --dry-run           Validate and print graph without executing",
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
 * 2. If it looks like a bare name (no path separators, no .dot extension),
 *    look in `.attractor/workflows/<name>.dot`.
 * 3. Return an error with actionable guidance.
 */
export function resolveWorkflowPath(
  cwd: string,
  ref: string,
): string {
  // 1. Direct file reference
  const direct = resolve(cwd, ref);
  if (existsSync(direct)) return direct;

  // 2. Bare name → .attractor/workflows/<name>.dot
  const isBare = !ref.includes("/") && !ref.includes("\\") && extname(ref) === "";
  if (isBare) {
    const conventional = resolve(cwd, ".attractor", "workflows", `${ref}.dot`);
    if (existsSync(conventional)) return conventional;

    throw new CommandParseError(
      `Workflow "${ref}" not found.\n` +
      `Searched:\n` +
      `  ${direct}\n` +
      `  ${conventional}\n` +
      `Place workflow files in .attractor/workflows/ or provide a full path.`,
    );
  }

  throw new CommandParseError(
    `Workflow file not found: ${direct}\n` +
    `Provide a valid path to a .dot workflow file.`,
  );
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

  if (subcommand !== "run" && subcommand !== "validate") {
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

  if (!workflowRef) {
    throw new CommandParseError(
      `Missing workflow file.\n\n${usageText()}`,
    );
  }

  const workflowPath = resolveWorkflowPath(cwd, workflowRef);

  if (subcommand === "validate") {
    return { subcommand: "validate", workflowPath };
  }

  // Validate --tools value
  const VALID_TOOL_MODES = new Set(["none", "read-only", "coding"]);
  if (typeof flags.tools === "string" && !VALID_TOOL_MODES.has(flags.tools)) {
    throw new CommandParseError(
      `Invalid --tools value: "${flags.tools}". Must be one of: none, read-only, coding`,
    );
  }

  return {
    subcommand: "run",
    workflowPath,
    goal: typeof flags.goal === "string" ? flags.goal : undefined,
    resume: flags.resume === true,
    approveAll: flags["approve-all"] === true,
    logs: typeof flags.logs === "string" ? flags.logs : undefined,
    tools: typeof flags.tools === "string" ? flags.tools : undefined,
    dryRun: flags["dry-run"] === true,
  };
}
