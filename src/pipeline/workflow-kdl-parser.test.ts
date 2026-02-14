import { describe, it, expect } from "vitest";
import { parseWorkflowKdl } from "./workflow-kdl-parser.js";

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

  it("preserves URLs containing // inside strings", () => {
    const wf = parseWorkflowKdl(`
      workflow "url-test" {
        version 2
        start "plan"

        stage "plan" kind="llm" prompt="Visit https://example.com/path for info"
        stage "exit" kind="exit"

        transition from="plan" to="exit"
      }
    `);

    const plan = wf.stages.find((s) => s.id === "plan");
    expect(plan?.kind).toBe("llm");
    expect((plan as any).prompt).toBe("Visit https://example.com/path for info");
  });

  it("preserves block comment markers inside strings", () => {
    const wf = parseWorkflowKdl(`
      workflow "block-test" {
        version 2
        start "plan"

        stage "plan" kind="llm" prompt="Use /* and */ as delimiters"
        stage "exit" kind="exit"

        transition from="plan" to="exit"
      }
    `);

    const plan = wf.stages.find((s) => s.id === "plan");
    expect((plan as any).prompt).toBe("Use /* and */ as delimiters");
  });

  it("strips line comments outside strings", () => {
    const wf = parseWorkflowKdl(`
      workflow "comment-test" {
        version 2
        start "plan"

        // This is a comment
        stage "plan" kind="llm" prompt="Hello" // inline comment
        stage "exit" kind="exit"

        transition from="plan" to="exit"
      }
    `);

    expect(wf.stages).toHaveLength(2);
  });

  it("strips block comments outside strings", () => {
    const wf = parseWorkflowKdl(`
      workflow "block-comment-test" {
        version 2
        start "plan"

        /* multi
           line
           comment */
        stage "plan" kind="llm" prompt="Hello"
        stage "exit" kind="exit"

        transition from="plan" to="exit"
      }
    `);

    expect(wf.stages).toHaveLength(2);
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
