import { describe, it, expect } from "vitest";
import type { WorkflowDefinition, WorkflowTransition, WorkflowHumanStage, WorkflowDiagnostic } from "./workflow-types.js";
import type { Severity } from "./types.js";
import { validateWorkflow, validateWorkflowOrRaise } from "./workflow-validator.js";

type BaseWorkflow = WorkflowDefinition & { transitions: WorkflowTransition[] };

/** Assert that diagnostics contain a matching rule with the expected severity. */
function expectDiag(diags: WorkflowDiagnostic[], rule: string, severity: Severity): void {
  const match = diags.find((d) => d.rule === rule);
  expect(match, `expected diagnostic "${rule}" to be present`).toBeDefined();
  expect(match!.severity).toBe(severity);
}

function baseWorkflow(): BaseWorkflow {
  return {
    version: 2,
    name: "test",
    start: "plan",
    stages: [
      { id: "plan", kind: "llm", prompt: "plan it" },
      { id: "review", kind: "human", prompt: "review", options: [
        { key: "a", label: "Approve", to: "exit" },
        { key: "r", label: "Revise", to: "plan" },
      ] },
      { id: "exit", kind: "exit" },
    ],
    transitions: [
      { from: "plan", to: "review" },
    ],
  };
}

describe("Workflow validator", () => {
  it("accepts a valid minimal workflow", () => {
    const wf = baseWorkflow();
    const diags = validateWorkflow(wf);
    expect(diags.filter((d) => d.severity === "error")).toEqual([]);
    expect(() => validateWorkflowOrRaise(wf)).not.toThrow();
  });

  it("throws on invalid workflow with descriptive message", () => {
    const wf = baseWorkflow();
    wf.start = "nonexistent";
    expect(() => validateWorkflowOrRaise(wf)).toThrow("Workflow validation failed");
  });

  it("rejects global transitions from human stages", () => {
    const wf = baseWorkflow();
    wf.transitions.push({ from: "review", to: "exit" });
    const diags = validateWorkflow(wf);
    expectDiag(diags, "workflow_routing_partition", "error");
  });

  it("rejects transition with unknown source stage", () => {
    const wf = baseWorkflow();
    wf.transitions.push({ from: "ghost", to: "exit" });
    const diags = validateWorkflow(wf);
    expectDiag(diags, "workflow_transition_from", "error");
    expect(diags.find((d) => d.rule === "workflow_transition_from")!.message).toContain('"ghost"');
  });

  it("rejects transition with unknown target stage", () => {
    const wf = baseWorkflow();
    wf.transitions.push({ from: "plan", to: "nowhere" });
    const diags = validateWorkflow(wf);
    expectDiag(diags, "workflow_transition_to", "error");
    expect(diags.find((d) => d.rule === "workflow_transition_to")!.message).toContain('"nowhere"');
  });

  it("rejects human stage with fewer than 2 options", () => {
    const wf = baseWorkflow();
    const reviewStage = wf.stages.find((s) => s.id === "review") as WorkflowHumanStage;
    reviewStage.options = [{ key: "a", label: "Approve", to: "exit" }];
    const diags = validateWorkflow(wf);
    expectDiag(diags, "workflow_human_options", "error");
    expect(diags.find((d) => d.rule === "workflow_human_options")!.message).toContain('"review"');
  });

  it("requires decision catch-all", () => {
    const wf: WorkflowDefinition = {
      version: 2,
      name: "decision",
      start: "gate",
      stages: [
        { id: "gate", kind: "decision", routes: [{ when: "outcome(\"build\") == \"success\"", to: "exit" }] },
        { id: "build", kind: "tool", command: "echo ok" },
        { id: "exit", kind: "exit" },
      ],
      transitions: [{ from: "build", to: "gate" }],
    };

    const diags = validateWorkflow(wf);
    expectDiag(diags, "workflow_decision_catch_all", "error");
  });

  it("rejects transition with malformed expression syntax", () => {
    const wf = baseWorkflow();
    wf.transitions[0].when = 'outcome("x"';
    const diags = validateWorkflow(wf);
    expectDiag(diags, "workflow_expression_syntax", "error");
  });

  it("rejects unknown expression stage refs", () => {
    const wf = baseWorkflow();
    wf.transitions[0].when = 'outcome("missing") == "success"';
    const diags = validateWorkflow(wf);
    expectDiag(diags, "workflow_expression_stage_ref", "error");
  });

  it("rejects workflow with wrong version", () => {
    const wf = baseWorkflow();
    (wf as { version: number }).version = 1;
    const diags = validateWorkflow(wf);
    expectDiag(diags, "workflow_version", "error");
    expect(diags.find((d) => d.rule === "workflow_version")!.message).toContain("got: 1");
  });

  it("rejects start referencing a missing stage", () => {
    const wf = baseWorkflow();
    wf.start = "nonexistent";
    const diags = validateWorkflow(wf);
    expectDiag(diags, "workflow_start_exists", "error");
    expect(diags.find((d) => d.rule === "workflow_start_exists")!.message).toContain('"nonexistent"');
  });

  it("rejects duplicate stage IDs", () => {
    const wf = baseWorkflow();
    wf.stages.push({ id: "plan", kind: "llm", prompt: "duplicate" });
    const diags = validateWorkflow(wf);
    expectDiag(diags, "workflow_duplicate_stage", "error");
    expect(diags.find((d) => d.rule === "workflow_duplicate_stage")!.message).toContain('"plan"');
  });

  it("rejects model_profile referencing unknown profile", () => {
    const wf = baseWorkflow();
    wf.stages[0] = { id: "plan", kind: "llm", prompt: "plan it", model_profile: "fast" };
    const diags = validateWorkflow(wf);
    expectDiag(diags, "workflow_model_profile", "error");
    expect(diags.find((d) => d.rule === "workflow_model_profile")!.message).toContain('"fast"');
  });

  it("accepts model_profile referencing a defined profile", () => {
    const wf = baseWorkflow();
    wf.models = { profile: { fast: { model: "claude-haiku" } } };
    wf.stages[0] = { id: "plan", kind: "llm", prompt: "plan it", model_profile: "fast" };
    const diags = validateWorkflow(wf);
    expect(diags.some((d) => d.rule === "workflow_model_profile")).toBe(false);
  });

  it("rejects retry with max_attempts of 0", () => {
    const wf = baseWorkflow();
    wf.stages[0] = { id: "plan", kind: "llm", prompt: "plan it", retry: { max_attempts: 0 } };
    const diags = validateWorkflow(wf);
    expectDiag(diags, "workflow_retry_max_attempts", "error");
  });

  it("rejects retry with non-integer max_attempts", () => {
    const wf = baseWorkflow();
    wf.stages[0] = { id: "plan", kind: "llm", prompt: "plan it", retry: { max_attempts: 1.5 } };
    const diags = validateWorkflow(wf);
    expectDiag(diags, "workflow_retry_max_attempts", "error");
  });

  it("accepts valid retry config", () => {
    const wf = baseWorkflow();
    wf.stages[0] = { id: "plan", kind: "llm", prompt: "plan it", retry: { max_attempts: 3 } };
    const diags = validateWorkflow(wf);
    expect(diags.some((d) => d.rule === "workflow_retry_max_attempts")).toBe(false);
  });

  it("rejects prompt_file with directory traversal", () => {
    const wf = baseWorkflow();
    wf.stages[0] = { id: "plan", kind: "llm", prompt_file: "../../etc/passwd" };
    const diags = validateWorkflow(wf);
    expectDiag(diags, "workflow_prompt_file_path", "error");
  });

  it("rejects prompt_file with absolute path", () => {
    const wf = baseWorkflow();
    wf.stages[0] = { id: "plan", kind: "llm", prompt_file: "/etc/passwd" };
    const diags = validateWorkflow(wf);
    expectDiag(diags, "workflow_prompt_file_path", "error");
  });

  it("accepts prompt_file with valid relative path", () => {
    const wf = baseWorkflow();
    wf.stages[0] = { id: "plan", kind: "llm", prompt_file: "prompts/plan.md" };
    const diags = validateWorkflow(wf);
    expect(diags.some((d) => d.rule === "workflow_prompt_file_path")).toBe(false);
  });

  it("rejects tool stages with empty command", () => {
    const wf: WorkflowDefinition = {
      version: 2,
      name: "tool-test",
      start: "run",
      stages: [
        { id: "run", kind: "tool", command: "   " },
        { id: "exit", kind: "exit" },
      ],
      transitions: [{ from: "run", to: "exit" }],
    };
    const diags = validateWorkflow(wf);
    expectDiag(diags, "workflow_tool_command", "error");
    expect(diags.find((d) => d.rule === "workflow_tool_command")!.message).toContain('"run"');
  });

  it("rejects llm stages that define both prompt and prompt_file", () => {
    const wf = baseWorkflow();
    wf.stages[0] = { id: "plan", kind: "llm", prompt: "x", prompt_file: "prompts/x.md" };
    const diags = validateWorkflow(wf);
    expectDiag(diags, "workflow_llm_prompt", "error");
  });

  it("rejects workflows without reachable exit", () => {
    const wf = baseWorkflow();
    wf.transitions = [{ from: "plan", to: "review" }];
    // make human options loop forever
    const reviewStage = wf.stages.find((s) => s.id === "review") as WorkflowHumanStage;
    reviewStage.options = [
      { key: "r1", label: "Revise", to: "plan" },
      { key: "r2", label: "Revise again", to: "plan" },
    ];

    const diags = validateWorkflow(wf);
    expectDiag(diags, "workflow_reachable_exit", "error");
  });
});
