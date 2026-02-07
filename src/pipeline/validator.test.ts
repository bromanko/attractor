import { describe, it, expect } from "vitest";
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
});
