import { describe, it, expect } from "vitest";
import {
  collectExpressionStageRefs,
  compileExprToEngineConditions,
  isPlausibleExpression,
  type EngineConditions,
} from "./workflow-expr.js";

/** Compile and assert the result is a disjunction, returning its clauses. */
function compileClauses(expr: string): string[] {
  const result = compileExprToEngineConditions(expr);
  expect(result.kind).toBe("disjunction");
  return (result as Extract<EngineConditions, { kind: "disjunction" }>).clauses;
}

/* ------------------------------------------------------------------ */
/*  isPlausibleExpression                                              */
/* ------------------------------------------------------------------ */

describe("isPlausibleExpression", () => {
  it("accepts a simple outcome comparison", () => {
    expect(isPlausibleExpression('outcome("build") == "success"')).toBe(true);
  });

  it("accepts && conjunction", () => {
    expect(isPlausibleExpression('outcome("a") == "ok" && outcome("b") == "ok"')).toBe(true);
  });

  it("accepts || disjunction", () => {
    expect(isPlausibleExpression('outcome("a") == "ok" || outcome("b") == "ok"')).toBe(true);
  });

  it("accepts ! negation", () => {
    expect(isPlausibleExpression('!exists("review.feedback")')).toBe(true);
  });

  it("accepts nested parentheses", () => {
    expect(isPlausibleExpression('(outcome("a") == "ok")')).toBe(true);
    expect(isPlausibleExpression('((outcome("a") == "ok"))')).toBe(true);
  });

  it("accepts combined operators with parentheses", () => {
    const expr =
      'outcome("build") == "success" || (!exists("review.feedback") && output("risk.level") != "high")';
    expect(isPlausibleExpression(expr)).toBe(true);
  });

  it("accepts bare exists call", () => {
    expect(isPlausibleExpression('exists("review.feedback")')).toBe(true);
  });

  it("accepts boolean literals", () => {
    expect(isPlausibleExpression("true")).toBe(true);
    expect(isPlausibleExpression("false")).toBe(true);
  });

  // --- rejection cases ---

  it("rejects empty string", () => {
    expect(isPlausibleExpression("")).toBe(false);
  });

  it("rejects whitespace-only string", () => {
    expect(isPlausibleExpression("   ")).toBe(false);
    expect(isPlausibleExpression("\t\n")).toBe(false);
  });

  it("rejects unbalanced parens — missing close", () => {
    expect(isPlausibleExpression('(outcome("a") == "ok"')).toBe(false);
  });

  it("rejects unbalanced parens — extra close", () => {
    expect(isPlausibleExpression('outcome("a") == "ok")')).toBe(false);
  });

  it("rejects unbalanced parens — reversed", () => {
    expect(isPlausibleExpression(')(outcome("a") == "ok"')).toBe(false);
  });

  it("rejects unbalanced parens — extra nesting open", () => {
    expect(isPlausibleExpression('((outcome("a") == "ok")')).toBe(false);
  });

  it("rejects unbalanced parens — extra nesting close", () => {
    expect(isPlausibleExpression('(outcome("a") == "ok"))')).toBe(false);
  });

  it("rejects shell injection attempts — dollar-paren subshell", () => {
    expect(isPlausibleExpression("$(rm -rf /)")).toBe(false);
  });

  it("rejects shell injection attempts — semicolons", () => {
    expect(isPlausibleExpression('outcome("a") == "ok"; rm -rf /')).toBe(false);
  });

  it("rejects shell injection attempts — backticks", () => {
    expect(isPlausibleExpression("`whoami`")).toBe(false);
  });

  it("rejects curly braces", () => {
    expect(isPlausibleExpression('{ outcome("a") == "ok" }')).toBe(false);
  });

  it("rejects square brackets", () => {
    expect(isPlausibleExpression('outcome("a") == ["ok"]')).toBe(false);
  });

  it("rejects bare identifiers that are not known functions or booleans", () => {
    expect(isPlausibleExpression("foobar")).toBe(false);
  });

  it("rejects single = (assignment) instead of ==", () => {
    expect(isPlausibleExpression('outcome("a") = "ok"')).toBe(false);
  });

  it("rejects lone operators", () => {
    expect(isPlausibleExpression("&&")).toBe(false);
    expect(isPlausibleExpression("||")).toBe(false);
    expect(isPlausibleExpression("!")).toBe(false);
  });

  it("rejects single-quoted strings", () => {
    expect(isPlausibleExpression("outcome('a') == 'ok'")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  collectExpressionStageRefs                                         */
/* ------------------------------------------------------------------ */

describe("collectExpressionStageRefs", () => {
  it("collects stage refs from outcome/output/exists", () => {
    const refs = collectExpressionStageRefs(
      'outcome("a") == "success" && output("b.value") == "x" && exists("c.z")',
    );
    expect(refs).toEqual([
      { fn: "outcome", stageId: "a" },
      { fn: "output", stageId: "b" },
      { fn: "exists", stageId: "c" },
    ]);
  });

  it("returns empty array for boolean-only expression", () => {
    expect(collectExpressionStageRefs("true")).toEqual([]);
    expect(collectExpressionStageRefs("false")).toEqual([]);
  });

  it("extracts the full arg for outcome (no dot splitting)", () => {
    const refs = collectExpressionStageRefs('outcome("my-stage") == "success"');
    expect(refs).toEqual([{ fn: "outcome", stageId: "my-stage" }]);
  });

  it("extracts only the first segment for output (dot splitting)", () => {
    const refs = collectExpressionStageRefs('output("deep.nested.key") == "val"');
    expect(refs).toEqual([{ fn: "output", stageId: "deep" }]);
  });

  it("extracts only the first segment for exists (dot splitting)", () => {
    const refs = collectExpressionStageRefs('exists("stage.key.sub")');
    expect(refs).toEqual([{ fn: "exists", stageId: "stage" }]);
  });

  it("collects refs from both sides of ||", () => {
    const refs = collectExpressionStageRefs(
      'outcome("a") == "ok" || outcome("b") == "ok"',
    );
    expect(refs).toEqual([
      { fn: "outcome", stageId: "a" },
      { fn: "outcome", stageId: "b" },
    ]);
  });

  it("collects refs through negation", () => {
    const refs = collectExpressionStageRefs('!exists("review.feedback")');
    expect(refs).toEqual([{ fn: "exists", stageId: "review" }]);
  });

  it("collects repeated refs (duplicates preserved)", () => {
    const refs = collectExpressionStageRefs(
      'outcome("a") == "ok" && outcome("a") != "fail"',
    );
    expect(refs).toEqual([
      { fn: "outcome", stageId: "a" },
      { fn: "outcome", stageId: "a" },
    ]);
  });

  it("throws on empty string", () => {
    expect(() => collectExpressionStageRefs("")).toThrow();
  });

  it("throws on unknown functions", () => {
    expect(() => collectExpressionStageRefs('status("a") == "ok"')).toThrow(/Unknown function/);
  });

  it("throws on calls without quoted arguments", () => {
    expect(() => collectExpressionStageRefs("outcome(a) == \"ok\"")).toThrow();
  });

  it("throws on malformed expression with unbalanced parens", () => {
    expect(() => collectExpressionStageRefs('(outcome("a") == "ok"')).toThrow();
  });

  it("throws on garbage input", () => {
    expect(() => collectExpressionStageRefs("not a valid expression @#$")).toThrow();
  });

  it("throws on truncated expression", () => {
    expect(() => collectExpressionStageRefs('outcome("a") ==')).toThrow();
  });
});

/* ------------------------------------------------------------------ */
/*  Tokenizer edge cases (exercised via parse errors)                  */
/* ------------------------------------------------------------------ */

describe("tokenizer edge cases", () => {
  it("rejects unterminated strings", () => {
    expect(() => compileExprToEngineConditions('outcome("build) == "ok"')).toThrow(
      /Unterminated string/,
    );
  });

  it("rejects unexpected characters", () => {
    expect(() => compileExprToEngineConditions('outcome("a") == "ok" @ foo')).toThrow(
      /Unexpected character/,
    );
  });

  it("handles escape sequences in strings", () => {
    // Escaped quotes inside string arguments
    expect(compileClauses('output("a.key") == "hello\\"world"')).toEqual(['context.a.key=hello"world']);
  });

  it("handles \\n and \\t escape sequences", () => {
    expect(compileClauses('output("a.key") == "line\\none"')).toEqual(["context.a.key=line\none"]);
  });

  it("parses integer number literals", () => {
    expect(compileClauses('output("a.count") == 42')).toEqual(["context.a.count=42"]);
  });

  it("parses floating point number literals", () => {
    expect(compileClauses('output("a.score") == 3.14')).toEqual(["context.a.score=3.14"]);
  });

  it("rejects invalid number formats", () => {
    expect(() => compileExprToEngineConditions('output("a.v") == 1.2.3')).toThrow(
      /Invalid number/,
    );
  });

  it("rejects bare dash as unexpected character (no negative number literals)", () => {
    expect(() => compileExprToEngineConditions('output("a.v") == -42')).toThrow(
      /Unexpected character/,
    );
  });
});

/* ------------------------------------------------------------------ */
/*  Parser edge cases                                                  */
/* ------------------------------------------------------------------ */

describe("parser edge cases", () => {
  it("rejects missing rparen", () => {
    expect(() => compileExprToEngineConditions('(outcome("a") == "ok"')).toThrow(
      /Expected rparen/,
    );
  });

  it("rejects unknown function names", () => {
    expect(() => compileExprToEngineConditions('status("a") == "ok"')).toThrow(
      /Unknown function/,
    );
  });

  it("rejects exists() with == operator", () => {
    expect(() => compileExprToEngineConditions('exists("a.key") == "yes"')).toThrow(
      /exists.*does not support/,
    );
  });

  it("rejects exists() with != operator", () => {
    expect(() => compileExprToEngineConditions('exists("a.key") != "yes"')).toThrow(
      /exists.*does not support/,
    );
  });

  it("rejects trailing tokens after complete expression", () => {
    expect(() =>
      compileExprToEngineConditions('outcome("a") == "ok" outcome("b") == "ok"'),
    ).toThrow(/Unexpected token/);
  });

  it("rejects empty parens", () => {
    expect(() => compileExprToEngineConditions("()")).toThrow();
  });

  it("rejects single = (expected ==)", () => {
    expect(() => compileExprToEngineConditions('outcome("a") = "ok"')).toThrow(
      /Expected '=='/,
    );
  });

  it("rejects non-literal on RHS of comparison", () => {
    // RHS is an ident, not a string/number/boolean literal
    expect(() =>
      compileExprToEngineConditions('outcome("a") == outcome("b")'),
    ).toThrow(/Expected literal/);
  });

  it("rejects bare outcome() without comparison operator", () => {
    expect(() => compileExprToEngineConditions('outcome("build")')).toThrow(
      /requires comparison/,
    );
  });

  it("rejects bare output() without comparison operator", () => {
    expect(() => compileExprToEngineConditions('output("build.key")')).toThrow(
      /requires comparison/,
    );
  });

  it("rejects unexpected token in primary position (bare string literal)", () => {
    expect(() => compileExprToEngineConditions('"hello"')).toThrow(/Unexpected token/);
  });

  it("rejects unexpected token in primary position (bare number)", () => {
    expect(() => compileExprToEngineConditions("42")).toThrow(/Unexpected token/);
  });

  it("rejects function name without lparen", () => {
    expect(() => compileExprToEngineConditions('outcome "a"')).toThrow(
      /Expected lparen/,
    );
  });

  it("rejects function call with non-string argument", () => {
    expect(() => compileExprToEngineConditions("outcome(42) == \"ok\"")).toThrow(
      /Expected string/,
    );
  });

  it("rejects function call missing closing rparen", () => {
    expect(() => compileExprToEngineConditions('outcome("a" == "ok"')).toThrow(
      /Expected rparen/,
    );
  });
});

/* ------------------------------------------------------------------ */
/*  NNF (negation normal form) via compileExprToEngineConditions    */
/* ------------------------------------------------------------------ */

describe("NNF conversion", () => {
  it("double negation elimination", () => {
    // !!exists → exists (non-negated)
    expect(compileClauses('!!exists("a.key")')).toEqual(["context.a.key!="]);
  });

  it("De Morgan: !(A && B) → !A || !B", () => {
    // Negated conjunction → disjunction of negated atoms
    // !(a==ok && b==ok) → a!=ok || b!=ok → two engine clauses
    expect(compileClauses(
      '!(outcome("a") == "ok" && outcome("b") == "ok")',
    )).toEqual(["context.a.status!=ok", "context.b.status!=ok"]);
  });

  it("De Morgan: !(A || B) → !A && !B", () => {
    // Negated disjunction → conjunction of negated atoms → single clause
    expect(compileClauses(
      '!(outcome("a") == "ok" || outcome("b") == "ok")',
    )).toEqual(["context.a.status!=ok && context.b.status!=ok"]);
  });

  it("De Morgan on nested AND/OR", () => {
    // !(A && (B || C)) → !A || !(B || C) → !A || (!B && !C)
    expect(compileClauses(
      '!(outcome("a") == "ok" && (outcome("b") == "ok" || outcome("c") == "ok"))',
    )).toEqual([
      "context.a.status!=ok",
      "context.b.status!=ok && context.c.status!=ok",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/*  DNF expansion                                                      */
/* ------------------------------------------------------------------ */

describe("DNF expansion", () => {
  it("distributes AND over OR: A && (B || C) → (A&&B) || (A&&C)", () => {
    expect(compileClauses(
      'outcome("a") == "ok" && (outcome("b") == "ok" || outcome("c") == "ok")',
    )).toEqual([
      "context.a.status=ok && context.b.status=ok",
      "context.a.status=ok && context.c.status=ok",
    ]);
  });

  it("distributes (A || B) && (C || D) into four disjuncts", () => {
    const clauses = compileClauses(
      '(outcome("a") == "1" || outcome("b") == "2") && (outcome("c") == "3" || outcome("d") == "4")',
    );
    expect(clauses).toHaveLength(4);
    expect(clauses).toEqual([
      "context.a.status=1 && context.c.status=3",
      "context.a.status=1 && context.d.status=4",
      "context.b.status=2 && context.c.status=3",
      "context.b.status=2 && context.d.status=4",
    ]);
  });

  it("rejects expressions that exceed the DNF clause limit", () => {
    // 8 OR-pairs joined by AND → 2^8 = 256 clauses, exceeds 128 limit
    const pairs = Array.from({ length: 8 }, (_, i) => {
      const a = `s${i * 2}`;
      const b = `s${i * 2 + 1}`;
      return `(outcome("${a}") == "ok" || outcome("${b}") == "ok")`;
    });
    const expr = pairs.join(" && ");
    expect(() => compileExprToEngineConditions(expr)).toThrow(
      /DNF expansion exceeds 128 clauses/,
    );
  });
});

/* ------------------------------------------------------------------ */
/*  compileExprToEngineConditions                                   */
/* ------------------------------------------------------------------ */

describe("compileExprToEngineConditions", () => {
  it("compiles conjunction to single engine condition", () => {
    expect(compileClauses(
      'outcome("a") == "success" && output("b.key") == "x"',
    )).toEqual(["context.a.status=success && context.b.key=x"]);
  });

  it("lowers simple disjunctions to multiple engine conditions", () => {
    expect(compileClauses(
      'outcome("build") == "success" || output("review.status") == "pass"',
    )).toEqual(["context.build.status=success", "context.review.status=pass"]);
  });

  it("lowers negated exists", () => {
    expect(compileClauses('!exists("review.feedback")')).toEqual(["context.review.feedback="]);
  });

  it("lowers non-negated exists", () => {
    expect(compileClauses('exists("review.feedback")')).toEqual(["context.review.feedback!="]);
  });

  it("false literal → unsatisfiable", () => {
    expect(compileExprToEngineConditions("false")).toEqual({ kind: "unsatisfiable" });
  });

  it("true literal → unconditional", () => {
    expect(compileExprToEngineConditions("true")).toEqual({ kind: "unconditional" });
  });

  it("!= operator lowers correctly", () => {
    expect(compileClauses('outcome("build") != "fail"')).toEqual(["context.build.status!=fail"]);
  });

  it("output != lowers correctly", () => {
    expect(compileClauses('output("risk.level") != "high"')).toEqual(["context.risk.level!=high"]);
  });

  it("nested && within ||", () => {
    expect(compileClauses(
      '(outcome("a") == "ok" && outcome("b") == "ok") || outcome("c") == "ok"',
    )).toEqual([
      "context.a.status=ok && context.b.status=ok",
      "context.c.status=ok",
    ]);
  });

  it("deeply nested expression", () => {
    // DNF: (a==ok && exists(c.key)) || (b==ok && exists(c.key)) || d==done
    expect(compileClauses(
      '((outcome("a") == "ok" || outcome("b") == "ok") && exists("c.key")) || outcome("d") == "done"',
    )).toEqual([
      "context.a.status=ok && context.c.key!=",
      "context.b.status=ok && context.c.key!=",
      "context.d.status=done",
    ]);
  });

  it("true in conjunction is identity", () => {
    expect(compileClauses('true && outcome("a") == "ok"')).toEqual(["context.a.status=ok"]);
  });

  it("false in conjunction is absorbing", () => {
    expect(compileExprToEngineConditions('false && outcome("a") == "ok"')).toEqual({
      kind: "unsatisfiable",
    });
  });

  it("true in disjunction is absorbing", () => {
    expect(compileExprToEngineConditions('true || outcome("a") == "ok"')).toEqual({
      kind: "unconditional",
    });
  });

  it("false in disjunction is identity", () => {
    expect(compileClauses('false || outcome("a") == "ok"')).toEqual(["context.a.status=ok"]);
  });
});
