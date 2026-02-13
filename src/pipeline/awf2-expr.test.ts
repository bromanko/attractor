import { describe, it, expect } from "vitest";
import { collectExpressionStageRefs, isPlausibleExpression } from "./awf2-expr.js";

// ---------------------------------------------------------------------------
// collectExpressionStageRefs
// ---------------------------------------------------------------------------

describe("collectExpressionStageRefs", () => {
  it("extracts outcome refs", () => {
    const refs = collectExpressionStageRefs('outcome("build") == "success"');
    expect(refs).toEqual([{ fn: "outcome", stageId: "build" }]);
  });

  it("extracts output refs with dot-separated keys", () => {
    const refs = collectExpressionStageRefs('output("build.status")');
    expect(refs).toEqual([{ fn: "output", stageId: "build" }]);
  });

  it("extracts exists refs with dot-separated keys", () => {
    const refs = collectExpressionStageRefs('exists("deploy.log")');
    expect(refs).toEqual([{ fn: "exists", stageId: "deploy" }]);
  });

  it("returns empty array for no refs", () => {
    expect(collectExpressionStageRefs("true")).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(collectExpressionStageRefs("")).toEqual([]);
  });

  it("extracts multiple refs from compound expression", () => {
    const refs = collectExpressionStageRefs(
      'outcome("a") == "success" && exists("b.key")',
    );
    expect(refs).toEqual([
      { fn: "outcome", stageId: "a" },
      { fn: "exists", stageId: "b" },
    ]);
  });

  it("extracts multiple refs of the same function", () => {
    const refs = collectExpressionStageRefs(
      'outcome("x") == "success" || outcome("y") == "fail"',
    );
    expect(refs).toEqual([
      { fn: "outcome", stageId: "x" },
      { fn: "outcome", stageId: "y" },
    ]);
  });

  it("handles outcome without dot (stage id is the full arg)", () => {
    const refs = collectExpressionStageRefs('outcome("selfci")');
    expect(refs).toEqual([{ fn: "outcome", stageId: "selfci" }]);
  });

  it("handles output with deeply nested key", () => {
    const refs = collectExpressionStageRefs('output("stage.a.b.c")');
    expect(refs).toEqual([{ fn: "output", stageId: "stage" }]);
  });

  it("ignores unknown function names", () => {
    expect(collectExpressionStageRefs('unknown("stage")')).toEqual([]);
  });

  it("does not match single-quoted arguments", () => {
    expect(collectExpressionStageRefs("outcome('stage')")).toEqual([]);
  });

  it("does not match calls without quotes", () => {
    expect(collectExpressionStageRefs("outcome(stage)")).toEqual([]);
  });

  it("returns correct results on repeated calls (no lastIndex state leak)", () => {
    const first = collectExpressionStageRefs('outcome("a") == "success"');
    const second = collectExpressionStageRefs('exists("b.key")');
    expect(first).toEqual([{ fn: "outcome", stageId: "a" }]);
    expect(second).toEqual([{ fn: "exists", stageId: "b" }]);
  });
});

// ---------------------------------------------------------------------------
// isPlausibleExpression
// ---------------------------------------------------------------------------

describe("isPlausibleExpression", () => {
  it("accepts simple literal 'true'", () => {
    expect(isPlausibleExpression("true")).toBe(true);
  });

  it("accepts simple literal 'false'", () => {
    expect(isPlausibleExpression("false")).toBe(true);
  });

  it("accepts expression with balanced parens", () => {
    expect(isPlausibleExpression('outcome("a") == "success"')).toBe(true);
  });

  it("accepts nested balanced parens", () => {
    expect(isPlausibleExpression("((a))")).toBe(true);
  });

  it("accepts expression with no parens", () => {
    expect(isPlausibleExpression("a == b")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isPlausibleExpression("")).toBe(false);
  });

  it("rejects whitespace-only string", () => {
    expect(isPlausibleExpression("   ")).toBe(false);
  });

  it("rejects unbalanced open paren", () => {
    expect(isPlausibleExpression("(a")).toBe(false);
  });

  it("rejects unbalanced close paren", () => {
    expect(isPlausibleExpression("a)")).toBe(false);
  });

  it("rejects close before open", () => {
    expect(isPlausibleExpression(")(")).toBe(false);
  });

  it("rejects extra open parens", () => {
    expect(isPlausibleExpression("((a)")).toBe(false);
  });

  it("rejects extra close parens", () => {
    expect(isPlausibleExpression("(a))")).toBe(false);
  });

  it("accepts compound expression with balanced parens", () => {
    expect(
      isPlausibleExpression('(outcome("a") == "success") && (exists("b.k"))'),
    ).toBe(true);
  });

  it("rejects shell injection attempts", () => {
    expect(isPlausibleExpression('$(rm -rf /)')).toBe(false);
    expect(isPlausibleExpression('`whoami`')).toBe(false);
  });

  it("rejects semicolons and braces", () => {
    expect(isPlausibleExpression('true; rm -rf /')).toBe(false);
    expect(isPlausibleExpression('{ evil: true }')).toBe(false);
  });

  it("rejects square brackets", () => {
    expect(isPlausibleExpression('a[0]')).toBe(false);
  });

  it("allows single-quoted string literals", () => {
    expect(isPlausibleExpression("outcome('a') == 'success'")).toBe(true);
  });
});
