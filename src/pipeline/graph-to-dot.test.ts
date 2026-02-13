import { describe, it, expect } from "vitest";
import { graphToDot } from "./graph-to-dot.js";
import { workflowToGraph } from "./workflow-loader.js";
import { parseWorkflowKdl } from "./workflow-kdl-parser.js";
import type { Graph } from "./types.js";

describe("graphToDot", () => {
  it("serializes a minimal graph", () => {
    const graph: Graph = {
      name: "TestPipeline",
      attrs: { label: "TestPipeline" },
      nodes: [
        { id: "__start__", attrs: { shape: "Mdiamond", label: "Start" } },
        { id: "do_stuff", attrs: { label: "do_stuff", shape: "box" } },
        { id: "exit", attrs: { label: "exit", shape: "doubleoctagon" } },
      ],
      edges: [
        { from: "__start__", to: "do_stuff", attrs: {} },
        { from: "do_stuff", to: "exit", attrs: { label: "done" } },
      ],
      node_defaults: {},
      edge_defaults: {},
    };

    const dot = graphToDot(graph);

    expect(dot).toContain('digraph "TestPipeline"');
    expect(dot).toContain('"__start__"');
    expect(dot).toContain('shape="Mdiamond"');
    expect(dot).toContain('"__start__" -> "do_stuff"');
    expect(dot).toContain('"do_stuff" -> "exit"');
    expect(dot).toContain('label="done"');
    expect(dot).toContain("}");
  });

  it("escapes quotes in attribute values", () => {
    const graph: Graph = {
      name: "Quotes",
      attrs: {},
      nodes: [
        { id: "a", attrs: { label: 'say "hello"' } },
      ],
      edges: [],
      node_defaults: {},
      edge_defaults: {},
    };

    const dot = graphToDot(graph);
    expect(dot).toContain('label="say \\"hello\\""');
  });

  it("uses condition as edge label when no explicit label", () => {
    const graph: Graph = {
      name: "Cond",
      attrs: {},
      nodes: [
        { id: "a", attrs: {} },
        { id: "b", attrs: {} },
      ],
      edges: [
        { from: "a", to: "b", attrs: { condition: 'outcome("a") == "success"' } },
      ],
      node_defaults: {},
      edge_defaults: {},
    };

    const dot = graphToDot(graph);
    expect(dot).toContain('label="outcome(\\"a\\") == \\"success\\""');
  });

  it("merges label and condition when both are present", () => {
    const graph: Graph = {
      name: "Both",
      attrs: {},
      nodes: [
        { id: "a", attrs: {} },
        { id: "b", attrs: {} },
      ],
      edges: [
        { from: "a", to: "b", attrs: { label: "retry", condition: 'outcome("a") == "fail"' } },
      ],
      node_defaults: {},
      edge_defaults: {},
    };

    const dot = graphToDot(graph);
    expect(dot).toContain('label="retry [outcome(\\"a\\") == \\"fail\\"]"');
  });

  it("handles a graph with no nodes or edges", () => {
    const graph: Graph = {
      name: "Empty",
      attrs: {},
      nodes: [],
      edges: [],
      node_defaults: {},
      edge_defaults: {},
    };
    const dot = graphToDot(graph);
    expect(dot).toContain('digraph "Empty"');
    expect(dot).toContain("}");
    // Should not contain any node or edge definitions
    expect(dot).not.toContain("->");
    expect(dot).not.toMatch(/"\w+" \[/);  // no node attribute lines
  });

  it("ignores node_defaults and edge_defaults (current contract)", () => {
    const graph: Graph = {
      name: "Defaults",
      attrs: {},
      nodes: [
        { id: "a", attrs: { label: "A" } },
        { id: "b", attrs: { label: "B" } },
      ],
      edges: [
        { from: "a", to: "b", attrs: {} },
      ],
      node_defaults: { shape: "ellipse", style: "filled" },
      edge_defaults: { color: "red" },
    };

    const dot = graphToDot(graph);

    // node_defaults and edge_defaults are not emitted as DOT "node [...]" / "edge [...]" blocks
    expect(dot).not.toMatch(/^\s*node\s*\[/m);
    expect(dot).not.toMatch(/^\s*edge\s*\[/m);
    // Individual nodes should not inherit defaults into their attribute lists
    expect(dot).not.toContain("ellipse");
    expect(dot).not.toContain("filled");
    expect(dot).not.toContain("red");
  });

  it("round-trips through workflowToGraph", () => {
    const kdl = `
      workflow "RoundTrip" {
        version 2
        start "step1"
        stage "step1" kind="llm" prompt="Do it."
        stage "exit" kind="exit"
        transition from="step1" to="exit"
      }
    `;
    const workflow = parseWorkflowKdl(kdl);
    const graph = workflowToGraph(workflow);
    const dot = graphToDot(graph);

    expect(dot).toContain('digraph "RoundTrip"');
    expect(dot).toContain('"__start__" -> "step1"');
    expect(dot).toContain('"step1" -> "exit"');
  });
});
