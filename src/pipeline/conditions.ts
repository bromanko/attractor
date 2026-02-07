/**
 * Condition Expression Language — Section 10 of the Attractor Spec.
 * Minimal boolean expressions for edge guards.
 */

import type { Outcome, Context } from "./types.js";

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export type Clause = {
  key: string;
  operator: "=" | "!=";
  value: string;
};

export function parseCondition(condition: string): Clause[] {
  if (!condition.trim()) return [];
  const parts = condition.split("&&").map((s) => s.trim()).filter(Boolean);
  return parts.map(parseClause);
}

function parseClause(clause: string): Clause {
  if (clause.includes("!=")) {
    const [key, ...rest] = clause.split("!=");
    return { key: key.trim(), operator: "!=", value: rest.join("!=").trim() };
  }
  if (clause.includes("=")) {
    const [key, ...rest] = clause.split("=");
    return { key: key.trim(), operator: "=", value: rest.join("=").trim() };
  }
  // Bare key: truthy check
  return { key: clause.trim(), operator: "!=", value: "" };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function resolveKey(
  key: string,
  outcome: Outcome,
  context: Context,
): string {
  if (key === "outcome") return outcome.status;
  if (key === "preferred_label") return outcome.preferred_label ?? "";

  // context.* keys
  if (key.startsWith("context.")) {
    const contextKey = key.slice("context.".length);
    const val = context.get(key) ?? context.get(contextKey);
    return val != null ? String(val) : "";
  }

  // Direct context lookup for unqualified keys
  const val = context.get(key);
  return val != null ? String(val) : "";
}

function evaluateClause(
  clause: Clause,
  outcome: Outcome,
  context: Context,
): boolean {
  const resolved = resolveKey(clause.key, outcome, context);
  if (clause.operator === "=") return resolved === clause.value;
  if (clause.operator === "!=") return resolved !== clause.value;
  return false;
}

/**
 * Evaluate a condition expression against an outcome and context.
 * Returns true if all clauses are satisfied.
 * Empty condition always returns true.
 */
export function evaluateCondition(
  condition: string,
  outcome: Outcome,
  context: Context,
): boolean {
  if (!condition.trim()) return true;
  const clauses = parseCondition(condition);
  return clauses.every((c) => evaluateClause(c, outcome, context));
}
