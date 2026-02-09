import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validate, validateOrRaise } from "./validator.js";
import { parseDot } from "./dot-parser.js";

describe("Validator", () => {
  const validPipeline = `
    digraph Test {
      graph [goal="Test"]
      start [shape=Mdiamond]
      exit [shape=Msquare]
      work [shape=box, prompt="Do work"]
      start -> work -> exit
    }
  `;

  it("validates a correct pipeline with no errors", () => {
    const graph = parseDot(validPipeline);
    const diags = validate(graph);
    const errors = diags.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("detects missing start node", () => {
    const graph = parseDot(`
      digraph Test {
        exit [shape=Msquare]
        a [shape=box]
        a -> exit
      }
    `);
    const diags = validate(graph);
    expect(diags.some((d) => d.rule === "start_node")).toBe(true);
  });

  it("detects missing exit node", () => {
    const graph = parseDot(`
      digraph Test {
        start [shape=Mdiamond]
        a [shape=box]
        start -> a
      }
    `);
    const diags = validate(graph);
    expect(diags.some((d) => d.rule === "terminal_node")).toBe(true);
  });

  it("detects start with incoming edges", () => {
    const graph = parseDot(`
      digraph Test {
        start [shape=Mdiamond]
        exit [shape=Msquare]
        a [shape=box]
        a -> start
        start -> exit
      }
    `);
    const diags = validate(graph);
    expect(diags.some((d) => d.rule === "start_no_incoming")).toBe(true);
  });

  it("detects exit with outgoing edges", () => {
    const graph = parseDot(`
      digraph Test {
        start [shape=Mdiamond]
        exit [shape=Msquare]
        a [shape=box]
        start -> a -> exit
        exit -> a
      }
    `);
    const diags = validate(graph);
    expect(diags.some((d) => d.rule === "exit_no_outgoing")).toBe(true);
  });

  it("detects unreachable nodes", () => {
    const graph = parseDot(`
      digraph Test {
        start [shape=Mdiamond]
        exit [shape=Msquare]
        orphan [shape=box]
        start -> exit
      }
    `);
    const diags = validate(graph);
    expect(diags.some((d) => d.rule === "reachability")).toBe(true);
  });

  it("validateOrRaise throws on errors", () => {
    const graph = parseDot(`
      digraph Test {
        a [shape=box]
      }
    `);
    expect(() => validateOrRaise(graph)).toThrow("Pipeline validation failed");
  });

  it("validateOrRaise does not throw on warnings only", () => {
    const graph = parseDot(validPipeline);
    expect(() => validateOrRaise(graph)).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // prompt_file_exists
  // -----------------------------------------------------------------------

  it("warns when prompt_file does not exist", () => {
    const graph = parseDot(`
      digraph Test {
        graph [goal="Test"]
        start [shape=Mdiamond]
        exit [shape=Msquare]
        review [shape=box, prompt="Review", prompt_file="/nonexistent/review.md"]
        start -> review -> exit
      }
    `);
    const diags = validate(graph);
    const pf = diags.filter((d) => d.rule === "prompt_file_exists");
    expect(pf).toHaveLength(1);
    expect(pf[0].severity).toBe("warning");
    expect(pf[0].message).toContain("/nonexistent/review.md");
    expect(pf[0].node_id).toBe("review");
    expect(pf[0].fix).toBeDefined();
  });

  it("warns for each missing file in comma-separated prompt_file", () => {
    const graph = parseDot(`
      digraph Test {
        graph [goal="Test"]
        start [shape=Mdiamond]
        exit [shape=Msquare]
        review [shape=box, prompt="Review", prompt_file="/missing/a.md, /missing/b.md"]
        start -> review -> exit
      }
    `);
    const diags = validate(graph);
    const pf = diags.filter((d) => d.rule === "prompt_file_exists");
    expect(pf).toHaveLength(2);
    expect(pf[0].message).toContain("/missing/a.md");
    expect(pf[1].message).toContain("/missing/b.md");
  });

  it("does not warn when prompt_file exists", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "val-test-"));
    try {
      await writeFile(join(tmpDir, "skill.md"), "# Review skill");
      const graph = parseDot(`
        digraph Test {
          graph [goal="Test"]
          start [shape=Mdiamond]
          exit [shape=Msquare]
          review [shape=box, prompt="Review", prompt_file="${join(tmpDir, "skill.md")}"]
          start -> review -> exit
        }
      `);
      const diags = validate(graph);
      const pf = diags.filter((d) => d.rule === "prompt_file_exists");
      expect(pf).toHaveLength(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not warn when no prompt_file attribute", () => {
    const graph = parseDot(validPipeline);
    const diags = validate(graph);
    const pf = diags.filter((d) => d.rule === "prompt_file_exists");
    expect(pf).toHaveLength(0);
  });

  // failure_path rule
  it("warns when infrastructure node has no failure path", () => {
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        ci    [shape=parallelogram, tool_command="make test"]
        work  [shape=box]
        start -> ci -> work -> exit
      }
    `);
    const diags = validate(graph).filter((d) => d.rule === "failure_path");
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("ci");
  });

  it("no failure_path warning when infra node routes to diamond gate", () => {
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        ci    [shape=parallelogram, tool_command="make test"]
        gate  [shape=diamond]
        fix   [shape=box]
        start -> ci -> gate
        gate -> exit [condition="outcome=success"]
        gate -> fix  [condition="outcome!=success"]
        fix -> exit
      }
    `);
    const diags = validate(graph).filter((d) => d.rule === "failure_path");
    expect(diags).toHaveLength(0);
  });

  it("no failure_path warning when infra node has failure condition edge", () => {
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        ci    [shape=parallelogram, tool_command="make test"]
        fix   [shape=box]
        start -> ci
        ci -> exit [condition="outcome=success"]
        ci -> fix  [condition="outcome!=success"]
        fix -> exit
      }
    `);
    const diags = validate(graph).filter((d) => d.rule === "failure_path");
    expect(diags).toHaveLength(0);
  });

  it("does not flag LLM nodes for failure_path", () => {
    const graph = parseDot(`
      digraph G {
        start  [shape=Mdiamond]
        exit   [shape=Msquare]
        review [shape=box, prompt="Review code"]
        start -> review -> exit
      }
    `);
    const diags = validate(graph).filter((d) => d.rule === "failure_path");
    expect(diags).toHaveLength(0);
  });

  // conditional_gate_coverage rule
  it("warns when diamond gate only handles success", () => {
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        gate  [shape=diamond]
        work  [shape=box]
        start -> gate
        gate -> work [condition="outcome=success"]
        work -> exit
      }
    `);
    const diags = validate(graph).filter((d) => d.rule === "conditional_gate_coverage");
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("not failure");
  });

  it("no gate coverage warning when both outcomes handled", () => {
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        gate  [shape=diamond]
        fix   [shape=box]
        start -> gate
        gate -> exit [condition="outcome=success"]
        gate -> fix  [condition="outcome!=success"]
        fix -> exit
      }
    `);
    const diags = validate(graph).filter((d) => d.rule === "conditional_gate_coverage");
    expect(diags).toHaveLength(0);
  });

  // human_gate_options rule
  it("warns when human gate has fewer than 2 options", () => {
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        gate  [shape=hexagon]
        start -> gate -> exit
      }
    `);
    const diags = validate(graph).filter((d) => d.rule === "human_gate_options");
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("1 outgoing");
  });

  it("no human_gate warning when 2+ options present", () => {
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        gate  [shape=hexagon]
        a     [shape=box]
        b     [shape=box]
        start -> gate
        gate -> a [label="Yes"]
        gate -> b [label="No"]
        a -> exit
        b -> exit
      }
    `);
    const diags = validate(graph).filter((d) => d.rule === "human_gate_options");
    expect(diags).toHaveLength(0);
  });
});
