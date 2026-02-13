import { describe, it, expect } from "vitest";
import { parseWorkflowKdl } from "./awf2-kdl-parser.js";

describe("parseWorkflowKdl", () => {
  it("parses a minimal Workflow workflow", () => {
    const wf = parseWorkflowKdl(`
      workflow "demo" {
        version 2
        start "plan"

        stage "plan" kind="llm" prompt="Plan"
        stage "exit" kind="exit"

        transition from="plan" to="exit"
      }
    `);

    expect(wf.version).toBe(2);
    expect(wf.name).toBe("demo");
    expect(wf.start).toBe("plan");
    expect(wf.stages).toHaveLength(2);
    expect(wf.transitions).toHaveLength(1);
  });

  it("parses human options and decision routes", () => {
    const wf = parseWorkflowKdl(`
      workflow "demo" {
        version 2
        start "review"

        stage "review" kind="human" {
          prompt "Review"
          option "approve" label="Approve" to="exit"
          option "revise" label="Revise" to="revise"
        }

        stage "revise" kind="decision" {
          route when="true" to="exit"
        }

        stage "exit" kind="exit"
      }
    `);

    const human = wf.stages.find((s) => s.id === "review");
    const decision = wf.stages.find((s) => s.id === "revise");

    expect(human?.kind).toBe("human");
    expect(decision?.kind).toBe("decision");
  });
});
