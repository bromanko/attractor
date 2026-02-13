import { describe, it, expect } from "vitest";
import { parseWorkflowDefinition, workflowToGraph } from "./awf2-loader.js";

describe("Workflow loader", () => {
  it("parses + validates + lowers Workflow to Graph", () => {
    const source = `
      workflow "demo" {
        version 2
        goal "test"
        start "plan"

        stage "plan" kind="llm" prompt="Plan"
        stage "gate" kind="decision" {
          route when="outcome(\\\"plan\\\") == \\\"success\\\" || output(\\\"plan.review\\\") == \\\"ok\\\"" to="exit"
          route when="true" to="fix"
        }
        stage "fix" kind="llm" prompt="Fix"
        stage "exit" kind="exit"

        transition from="plan" to="gate"
        transition from="fix" to="gate"
      }
    `;

    const workflow = parseWorkflowDefinition(source);
    const graph = workflowToGraph(workflow);

    expect(graph.name).toBe("demo");
    expect(graph.nodes.some((n) => n.id === "__start__" && n.attrs.shape === "Mdiamond")).toBe(true);
    expect(graph.edges.some((e) => e.from === "__start__" && e.to === "plan")).toBe(true);

    // The OR expression should produce exactly two gate→exit edges (one per disjunct)
    const gateToExit = graph.edges.filter((e) => e.from === "gate" && e.to === "exit");
    expect(gateToExit).toHaveLength(2);
    expect(gateToExit.map((e) => e.attrs.condition)).toEqual(
      expect.arrayContaining([
        "context.plan.status=success",
        "context.plan.review=ok",
      ]),
    );
  });
});
