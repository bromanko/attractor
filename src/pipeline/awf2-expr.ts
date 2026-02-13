/**
 * AWF2 expression helpers.
 *
 * v2 keeps expressions intentionally small. This module provides lightweight
 * static analysis helpers used by validation.
 */

export type ExpressionStageRef = {
  fn: "outcome" | "output" | "exists";
  stageId: string;
};

/**
 * Collect stage references from AWF2 `when` expressions.
 *
 * - outcome("stage") -> stageId "stage"
 * - output("stage.key") -> stageId "stage"
 * - exists("stage.key") -> stageId "stage"
 */
export function collectExpressionStageRefs(expr: string): ExpressionStageRef[] {
  const re = /(outcome|output|exists)\("([^"]+)"\)/g;
  const refs: ExpressionStageRef[] = [];
  for (const match of expr.matchAll(re)) {
    const fn = match[1];
    if (fn !== "outcome" && fn !== "output" && fn !== "exists") continue;
    const raw = match[2];
    if (raw === undefined) continue; // guaranteed non-empty by [^"]+ in regex
    const stageId = fn === "outcome" ? raw : raw.split(".")[0] ?? "";
    refs.push({ fn, stageId });
  }
  return refs;
}

/**
 * Allowlist of characters permitted in AWF2 `when` expressions.
 *
 * Allows: identifiers, whitespace, parentheses, string literals (double-
 * quoted), comparison/boolean operators, dots, and commas. Rejects anything
 * outside this set to prevent injection of shell commands, JS code, etc.
 *
 * SECURITY: Expressions validated here must still be parsed by a dedicated
 * evaluator — never passed to `eval` or similar dynamic execution.
 */
const SAFE_EXPR_RE = /^[\w\s().,"'=!<>|&]+$/;

/**
 * Syntax sanity check for AWF2 `when` expressions.
 *
 * Validates that the expression:
 * 1. Is non-empty.
 * 2. Contains only allowlisted characters (identifiers, operators, literals).
 * 3. Has balanced parentheses.
 *
 * Limitation: the paren balance check does not skip parentheses inside quoted
 * strings, so e.g. `outcome("stage(1)")` would be rejected as unbalanced.
 * This is acceptable until the full parser/evaluator is added.
 */
export function isPlausibleExpression(expr: string): boolean {
  const trimmed = expr.trim();
  if (!trimmed) return false;

  // Reject characters outside the safe allowlist
  if (!SAFE_EXPR_RE.test(trimmed)) return false;

  // Paren balance check
  let depth = 0;
  for (const ch of trimmed) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth < 0) return false;
  }
  if (depth !== 0) return false;

  return true;
}
