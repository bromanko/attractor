import { describe, it, expect } from "vitest";
import { parseAwf2Workflow, awf2ToGraph } from "./awf2-loader.js";

describe("AWF2 loader", () => {
  it("parses + validates + lowers AWF2 to Graph", () => {
    const source = `
      workflow "demo" {
        version 2
        goal "test"
        start "plan"

        stage "plan" kind="llm" prompt="Plan"
        stage "gate" kind="decision" {
          route when="outcome(\\\"plan\\\") == \\\"success\\\"" to="exit"
          route when="true" to="fix"
        }
        stage "fix" kind="llm" prompt="Fix"
        stage "exit" kind="exit"

        transition from="plan" to="gate"
        transition from="fix" to="gate"
      }
    `;

    const awf2 = parseAwf2Workflow(source);
    const graph = awf2ToGraph(awf2);

    expect(graph.name).toBe("demo");
    expect(graph.nodes.some((n) => n.id === "__start__" && n.attrs.shape === "Mdiamond")).toBe(true);
    expect(graph.edges.some((e) => e.from === "__start__" && e.to === "plan")).toBe(true);
    expect(graph.edges.some((e) => e.from === "gate" && e.to === "exit" && e.attrs.condition === "outcome=success")).toBe(true);
  });
});
