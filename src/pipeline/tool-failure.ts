/**
 * Tool failure diagnostics — best-effort digest extraction.
 *
 * Provides structured failure classification and concise digest generation
 * for tool stage failures, with special handling for `selfci` output.
 */

import type { ToolFailureClass } from "./types.js";
export type { ToolFailureClass };

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/**
 * Structured payload for a tool stage failure.
 */
export type ToolFailureDetails = {
  failureClass: ToolFailureClass;
  digest: string;
  command: string;
  cwd?: string;
  exitCode?: number | null;
  signal?: string | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  artifactPaths: {
    stdout: string;
    stderr: string;
    meta: string;
  };
  firstFailingCheck?: string;
};

// ---------------------------------------------------------------------------
// Tail extraction helper
// ---------------------------------------------------------------------------

const TAIL_LINES = 30;
const TAIL_MAX_CHARS = 4096;

/**
 * Extract the last N lines of output, capped at a maximum character count.
 */
export function extractTail(text: string, maxLines = TAIL_LINES, maxChars = TAIL_MAX_CHARS): string {
  if (!text) return "";
  const lines = text.split("\n");
  const tail = lines.slice(-maxLines).join("\n");
  if (tail.length <= maxChars) return tail;
  return tail.slice(-maxChars);
}

// ---------------------------------------------------------------------------
// Failure class detection
// ---------------------------------------------------------------------------

export function classifyFailure(error: Error & { code?: string; killed?: boolean; signal?: string | null }): ToolFailureClass {
  // Timeout: node child_process sets killed=true when the process exceeds the timeout
  if (error.killed || error.signal === "SIGTERM") {
    return "timeout";
  }
  // Spawn errors: ENOENT, EACCES, etc.
  if (error.code === "ENOENT" || error.code === "EACCES" || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return "spawn_error";
  }
  return "exit_nonzero";
}

// ---------------------------------------------------------------------------
// Digest extraction
// ---------------------------------------------------------------------------

/**
 * Detect whether a command is in the `selfci` family.
 */
export function isSelfciCommand(command: string): boolean {
  // Match common selfci invocation patterns
  return /\bselfci\b/i.test(command) || /\bnpm\s+(?:run\s+)?(?:test|check|selfci)\b/i.test(command) ||
    /\bvitest\b/i.test(command) || /\bjest\b/i.test(command);
}

// Patterns for extracting first failing test/check from test runner output
const FAILING_CHECK_PATTERNS: readonly RegExp[] = [
  // Vitest: "FAIL  src/foo.test.ts > suite > test name"
  /^\s*(?:FAIL|×|✘)\s+(.+?)\s*$/m,
  // Jest/vitest: "● Suite › Test name"
  /^\s*●\s+(.+?)\s*$/m,
  // Generic "FAILED:" or "Error:" prefix
  /^\s*(?:FAILED|FAILURE|ERROR):\s*(.+?)\s*$/mi,
  // TAP: "not ok 1 - test description"
  /^\s*not ok\s+\d+\s*[-–]\s*(.+?)\s*$/m,
];

/**
 * Try to extract the name of the first failing check from combined output.
 */
export function extractFirstFailingCheck(stdout: string, stderr: string): string | undefined {
  const combined = stdout + "\n" + stderr;
  for (const pattern of FAILING_CHECK_PATTERNS) {
    const match = combined.match(pattern);
    if (match?.[1]) {
      return match[1].trim().slice(0, 200);
    }
  }
  return undefined;
}

// Patterns for extracting a concise selfci digest
const SELFCI_DIGEST_PATTERNS: readonly RegExp[] = [
  // "Tests:  X failed, Y passed, Z total"
  /Tests:\s+(\d+\s+failed.*?)$/m,
  // "X failing" or "X failed"
  /(\d+\s+(?:failing|failed)(?:\s+tests?)?)/mi,
  // "Test suite failed"
  /(Test suite[s]? failed.*?)$/m,
];

/**
 * Extract a concise digest from selfci/test-runner output.
 */
export function extractSelfciDigest(stdout: string, stderr: string): string | undefined {
  const combined = stdout + "\n" + stderr;
  for (const pattern of SELFCI_DIGEST_PATTERNS) {
    const match = combined.match(pattern);
    if (match?.[1]) {
      return match[1].trim().slice(0, 200);
    }
  }
  return undefined;
}

/**
 * Build a concise one-line digest for a tool failure.
 * Uses selfci-specific parsing when applicable, falls back to generic.
 */
export function buildDigest(opts: {
  command: string;
  failureClass: ToolFailureClass;
  exitCode?: number | null;
  signal?: string | null;
  stdout: string;
  stderr: string;
}): string {
  const { command, failureClass, exitCode, signal, stdout, stderr } = opts;

  // Timeout
  if (failureClass === "timeout") {
    return `Timed out: ${command.slice(0, 80)}`;
  }

  // Spawn error
  if (failureClass === "spawn_error") {
    const firstLine = (stderr || stdout).split("\n").find((l) => l.trim()) ?? "unknown error";
    return `Spawn error: ${firstLine.trim().slice(0, 120)}`;
  }

  // selfci-specific extraction
  if (isSelfciCommand(command)) {
    const digest = extractSelfciDigest(stdout, stderr);
    if (digest) return digest;
  }

  // Generic: use first non-empty stderr line, or exit code
  const stderrFirstLine = stderr.split("\n").find((l) => l.trim());
  if (stderrFirstLine) {
    return stderrFirstLine.trim().slice(0, 150);
  }

  const stdoutFirstLine = stdout.split("\n").find((l) => l.trim());
  if (stdoutFirstLine) {
    return stdoutFirstLine.trim().slice(0, 150);
  }

  if (signal) return `Killed by signal: ${signal}`;
  return `Exit code ${exitCode ?? "unknown"}`;
}
