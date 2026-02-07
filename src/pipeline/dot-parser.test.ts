import { describe, it, expect } from "vitest";
import { parseDot } from "./dot-parser.js";

describe("DOT Parser", () => {
  it("parses a simple linear pipeline", () => {
    const graph = parseDot(`
      digraph Simple {
        graph [goal="Run tests"]
        start [shape=Mdiamond, label="Start"]
        exit  [shape=Msquare, label="Exit"]
        run_tests [label="Run Tests", prompt="Run the test suite"]
        start -> run_tests -> exit
      }
    `);
    expect(graph.name).toBe("Simple");
    expect(graph.attrs.goal).toBe("Run tests");
    expect(graph.nodes.length).toBeGreaterThanOrEqual(3);
    expect(graph.edges.length).toBe(2);
  });

  it("parses graph-level attributes", () => {
    const graph = parseDot(`
      digraph Test {
        graph [goal="Feature X", label="My Pipeline"]
        start [shape=Mdiamond]
        exit [shape=Msquare]
        start -> exit
      }
    `);
    expect(graph.attrs.goal).toBe("Feature X");
    expect(graph.attrs.label).toBe("My Pipeline");
  });

  it("parses node attributes including multi-line", () => {
    const graph = parseDot(`
      digraph Test {
        start [shape=Mdiamond]
        exit [shape=Msquare]
        plan [
          label="Plan",
          prompt="Plan the implementation",
          max_retries=3,
          goal_gate=true
        ]
        start -> plan -> exit
      }
    `);
    const plan = graph.nodes.find((n) => n.id === "plan");
    expect(plan).toBeDefined();
    expect(plan!.attrs.label).toBe("Plan");
    expect(plan!.attrs.prompt).toBe("Plan the implementation");
    expect(plan!.attrs.max_retries).toBe(3);
    expect(plan!.attrs.goal_gate).toBe(true);
  });

  it("parses edge attributes", () => {
    const graph = parseDot(`
      digraph Test {
        start [shape=Mdiamond]
        exit [shape=Msquare]
        a [shape=box]
        start -> a
        a -> exit [label="Done", condition="outcome=success", weight=10]
      }
    `);
    const edge = graph.edges.find((e) => e.from === "a" && e.to === "exit");
    expect(edge).toBeDefined();
    expect(edge!.attrs.label).toBe("Done");
    expect(edge!.attrs.condition).toBe("outcome=success");
    expect(edge!.attrs.weight).toBe(10);
  });

  it("handles chained edges (A -> B -> C)", () => {
    const graph = parseDot(`
      digraph Test {
        start [shape=Mdiamond]
        exit [shape=Msquare]
        a [shape=box]
        b [shape=box]
        start -> a -> b -> exit [label="next"]
      }
    `);
    expect(graph.edges.length).toBe(3);
    expect(graph.edges[0]).toMatchObject({ from: "start", to: "a" });
    expect(graph.edges[1]).toMatchObject({ from: "a", to: "b" });
    expect(graph.edges[2]).toMatchObject({ from: "b", to: "exit" });
    // All edges get the same label
    for (const e of graph.edges) {
      expect(e.attrs.label).toBe("next");
    }
  });

  it("handles node/edge default blocks", () => {
    const graph = parseDot(`
      digraph Test {
        node [shape=box, timeout="900s"]
        edge [weight=0]
        start [shape=Mdiamond]
        exit [shape=Msquare]
        a [label="A"]
        start -> a -> exit
      }
    `);
    const a = graph.nodes.find((n) => n.id === "a");
    expect(a!.attrs.shape).toBe("box");
    expect(a!.attrs.timeout).toBe("900s");
  });

  it("strips comments", () => {
    const graph = parseDot(`
      // This is a comment
      digraph Test {
        /* Block comment */
        start [shape=Mdiamond] // inline
        exit [shape=Msquare]
        start -> exit
      }
    `);
    expect(graph.nodes.length).toBe(2);
  });

  it("handles quoted and unquoted values", () => {
    const graph = parseDot(`
      digraph Test {
        start [shape=Mdiamond]
        exit [shape=Msquare]
        a [label="Quoted Label", shape=box]
        start -> a -> exit
      }
    `);
    const a = graph.nodes.find((n) => n.id === "a");
    expect(a!.attrs.label).toBe("Quoted Label");
    expect(a!.attrs.shape).toBe("box");
  });

  it("handles subgraphs (flattened)", () => {
    const graph = parseDot(`
      digraph Test {
        start [shape=Mdiamond]
        exit [shape=Msquare]
        subgraph cluster_loop {
          node [thread_id="loop-a"]
          a [label="A"]
          b [label="B"]
          a -> b
        }
        start -> a
        b -> exit
      }
    `);
    const a = graph.nodes.find((n) => n.id === "a");
    expect(a).toBeDefined();
    expect(a!.attrs.thread_id).toBe("loop-a");
  });

  it("handles class attribute on nodes", () => {
    const graph = parseDot(`
      digraph Test {
        start [shape=Mdiamond]
        exit [shape=Msquare]
        review [shape=box, class="code,critical", prompt="Review"]
        start -> review -> exit
      }
    `);
    const review = graph.nodes.find((n) => n.id === "review");
    expect(review!.attrs.class).toBe("code,critical");
  });

  it("rejects undirected edges", () => {
    expect(() => parseDot(`
      digraph Test { a -- b }
    `)).toThrow("Undirected");
  });

  it("handles escape sequences in strings", () => {
    const graph = parseDot(`
      digraph Test {
        start [shape=Mdiamond]
        exit [shape=Msquare]
        a [prompt="line1\\nline2"]
        start -> a -> exit
      }
    `);
    const a = graph.nodes.find((n) => n.id === "a");
    expect(a!.attrs.prompt).toBe("line1\nline2");
  });
});
