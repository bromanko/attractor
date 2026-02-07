import { describe, it, expect } from "vitest";
import { evaluateCondition, parseCondition } from "./conditions.js";
import { Context } from "./types.js";
import type { Outcome } from "./types.js";

describe("Conditions", () => {
  const successOutcome: Outcome = { status: "success" };
  const failOutcome: Outcome = { status: "fail" };
  const ctx = new Context();

  it("empty condition returns true", () => {
    expect(evaluateCondition("", successOutcome, ctx)).toBe(true);
    expect(evaluateCondition("  ", failOutcome, ctx)).toBe(true);
  });

  it("outcome=success matches success", () => {
    expect(evaluateCondition("outcome=success", successOutcome, ctx)).toBe(true);
    expect(evaluateCondition("outcome=success", failOutcome, ctx)).toBe(false);
  });

  it("outcome!=success matches non-success", () => {
    expect(evaluateCondition("outcome!=success", failOutcome, ctx)).toBe(true);
    expect(evaluateCondition("outcome!=success", successOutcome, ctx)).toBe(false);
  });

  it("outcome=fail matches failure", () => {
    expect(evaluateCondition("outcome=fail", failOutcome, ctx)).toBe(true);
    expect(evaluateCondition("outcome=fail", successOutcome, ctx)).toBe(false);
  });

  it("context.* keys resolve against context", () => {
    const c = new Context();
    c.set("tests_passed", "true");
    expect(evaluateCondition("context.tests_passed=true", successOutcome, c)).toBe(true);
    expect(evaluateCondition("context.tests_passed=false", successOutcome, c)).toBe(false);
  });

  it("missing context keys compare as empty string", () => {
    expect(evaluateCondition("context.missing=", successOutcome, new Context())).toBe(true);
    expect(evaluateCondition("context.missing=something", successOutcome, new Context())).toBe(false);
  });

  it("&& conjunction requires all clauses", () => {
    const c = new Context();
    c.set("tests_passed", "true");
    expect(evaluateCondition("outcome=success && context.tests_passed=true", successOutcome, c)).toBe(true);
    expect(evaluateCondition("outcome=success && context.tests_passed=false", successOutcome, c)).toBe(false);
    expect(evaluateCondition("outcome=fail && context.tests_passed=true", successOutcome, c)).toBe(false);
  });

  it("preferred_label resolves correctly", () => {
    const outcome: Outcome = { status: "success", preferred_label: "Fix" };
    expect(evaluateCondition("preferred_label=Fix", outcome, ctx)).toBe(true);
    expect(evaluateCondition("preferred_label=Deploy", outcome, ctx)).toBe(false);
  });

  it("parseCondition returns correct clauses", () => {
    const clauses = parseCondition("outcome=success && context.x!=y");
    expect(clauses).toHaveLength(2);
    expect(clauses[0]).toEqual({ key: "outcome", operator: "=", value: "success" });
    expect(clauses[1]).toEqual({ key: "context.x", operator: "!=", value: "y" });
  });
});
