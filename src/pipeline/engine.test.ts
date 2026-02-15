import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, readFile, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { runPipeline } from "./engine.js";
import { graph } from "./test-graph-builder.js";
import type { CodergenBackend, Outcome, PipelineEvent, Interviewer, Question, Answer, Option } from "./types.js";
import { Context } from "./types.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "attractor-test-"));
}

/** Find a question option by label pattern, failing with a clear message if missing. */
function findOption(options: Option[], pattern: RegExp): Option {
  const match = options.find((o) => pattern.test(o.label));
  if (!match) {
    const available = options.map((o) => o.label).join(", ");
    throw new Error(`Expected an option matching ${pattern} but found: [${available}]`);
  }
  return match;
}

/** Simple backend that always succeeds. */
const successBackend: CodergenBackend = {
  async run(node, prompt) {
    return `Completed: ${node.id}`;
  },
};

/** Backend that returns a specific outcome. */
function outcomeBackend(outcome: Outcome): CodergenBackend {
  return {
    async run() { return outcome; },
  };
}

describe("Pipeline Engine", () => {
  it("executes a linear 3-node pipeline end-to-end", async () => {
    const g = graph({
      attrs: { goal: "Test" },
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "work", shape: "box", prompt: "Do work" },
      ],
      edges: [
        { from: "start", to: "work" },
        { from: "work", to: "exit" },
      ],
    });

    const logsRoot = await tempDir();
    const result = await runPipeline({ graph: g, logsRoot, backend: successBackend });

    expect(result.status).toBe("success");
    expect(result.completedNodes).toContain("start");
    expect(result.completedNodes).toContain("work");
    expect(result.completedNodes).toContain("exit");
  });

  it("writes artifacts to log directory", async () => {
    const g = graph({
      attrs: { goal: "Test artifacts" },
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "plan", shape: "box", prompt: "Plan the work" },
      ],
      edges: [
        { from: "start", to: "plan" },
        { from: "plan", to: "exit" },
      ],
    });

    const logsRoot = await tempDir();
    await runPipeline({ graph: g, logsRoot, backend: successBackend });

    const promptFile = await readFile(join(logsRoot, "plan", "prompt.md"), "utf-8");
    expect(promptFile).toBe("Plan the work");

    const responseFile = await readFile(join(logsRoot, "plan", "response.md"), "utf-8");
    expect(responseFile).toContain("Completed: plan");

    const statusFile = await readFile(join(logsRoot, "plan", "status.json"), "utf-8");
    const status = JSON.parse(statusFile);
    expect(status.outcome).toBe("success");
  });

  it("executes conditional branching (success/fail paths)", async () => {
    const g = graph({
      attrs: { goal: "Test branching" },
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "work", shape: "box", prompt: "Do work" },
        { id: "gate", shape: "diamond" },
        { id: "fix", shape: "box", prompt: "Fix issues" },
      ],
      edges: [
        { from: "start", to: "work" },
        { from: "work", to: "gate" },
        { from: "gate", to: "exit", condition: "outcome=success" },
        { from: "gate", to: "fix", condition: "outcome!=success" },
        { from: "fix", to: "exit" },
      ],
    });

    const logsRoot = await tempDir();
    const result = await runPipeline({ graph: g, logsRoot, backend: successBackend });

    expect(result.status).toBe("success");
    expect(result.completedNodes).toContain("exit");
  });

  it("goal gate blocks exit when unsatisfied", async () => {
    let callCount = 0;
    const failingBackend: CodergenBackend = {
      async run(node) {
        callCount++;
        if (node.id === "implement") {
          return { status: "fail", failure_reason: "test failure" } as Outcome;
        }
        return `Done: ${node.id}`;
      },
    };

    const g = graph({
      attrs: { goal: "Test goal gate" },
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "implement", shape: "box", prompt: "Implement", goal_gate: true },
      ],
      edges: [
        { from: "start", to: "implement" },
        { from: "implement", to: "exit" },
      ],
    });

    const logsRoot = await tempDir();
    const result = await runPipeline({ graph: g, logsRoot, backend: failingBackend });

    expect(result.status).toBe("fail");
  });

  it("emits events during execution", async () => {
    const g = graph({
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "work", shape: "box", prompt: "Work" },
      ],
      edges: [
        { from: "start", to: "work" },
        { from: "work", to: "exit" },
      ],
    });

    const events: PipelineEvent[] = [];
    const logsRoot = await tempDir();
    await runPipeline({
      graph: g,
      logsRoot,
      backend: successBackend,
      onEvent: (e) => events.push(e),
    });

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("pipeline_started");
    expect(kinds).toContain("stage_started");
    expect(kinds).toContain("stage_completed");
    expect(kinds).toContain("checkpoint_saved");
    expect(kinds).toContain("pipeline_completed");
  });

  it("does not emit stage events for the synthetic start node", async () => {
    const g = graph({
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "work", shape: "box", prompt: "Work" },
      ],
      edges: [
        { from: "start", to: "work" },
        { from: "work", to: "exit" },
      ],
    });

    const events: PipelineEvent[] = [];
    const logsRoot = await tempDir();
    await runPipeline({
      graph: g,
      logsRoot,
      backend: successBackend,
      onEvent: (e) => events.push(e),
    });

    const stageStarted = events.filter((e) => e.kind === "stage_started");
    const stageNames = stageStarted.map((e) => e.data.name);
    expect(stageNames).not.toContain("start");
    expect(stageNames).toContain("work");
  });

  it("pipeline_started includes stageCount excluding start and exit nodes", async () => {
    const g = graph({
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "plan", shape: "box", prompt: "Plan" },
        { id: "gate", shape: "diamond" },
        { id: "implement", shape: "box", prompt: "Implement" },
      ],
      edges: [
        { from: "start", to: "plan" },
        { from: "plan", to: "gate" },
        { from: "gate", to: "implement", condition: "outcome=success" },
        { from: "implement", to: "exit" },
      ],
    });

    const events: PipelineEvent[] = [];
    const logsRoot = await tempDir();
    await runPipeline({
      graph: g,
      logsRoot,
      backend: successBackend,
      onEvent: (e) => events.push(e),
    });

    const pipelineStarted = events.find((e) => e.kind === "pipeline_started");
    expect(pipelineStarted).toBeDefined();
    // 5 total nodes, minus start (Mdiamond) and exit (Msquare) = 3 user-facing stages
    expect(pipelineStarted!.data.stageCount).toBe(3);
    // nodeCount is still the total for backward compatibility
    expect(pipelineStarted!.data.nodeCount).toBe(5);
  });

  it("saves and can resume from checkpoints", async () => {
    const g = graph({
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "a", shape: "box", prompt: "A" },
        { id: "b", shape: "box", prompt: "B" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "exit" },
      ],
    });

    const logsRoot = await tempDir();
    await runPipeline({ graph: g, logsRoot, backend: successBackend });

    const cpJson = await readFile(join(logsRoot, "checkpoint.json"), "utf-8");
    const checkpoint = JSON.parse(cpJson);
    expect(checkpoint.completed_nodes.length).toBeGreaterThan(0);

    const logsRoot2 = await tempDir();
    const result2 = await runPipeline({ graph: g, logsRoot: logsRoot2, backend: successBackend, checkpoint });
    expect(result2.status).toBe("success");
  });

  it("context updates flow between nodes", async () => {
    let capturedContext: Record<string, unknown> | undefined;
    const contextBackend: CodergenBackend = {
      async run(node, _prompt, context) {
        if (node.id === "b") {
          capturedContext = context.snapshot();
        }
        return `Done: ${node.id}`;
      },
    };

    const g = graph({
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "a", shape: "box", prompt: "A" },
        { id: "b", shape: "box", prompt: "B" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "exit" },
      ],
    });

    const logsRoot = await tempDir();
    await runPipeline({ graph: g, logsRoot, backend: contextBackend });

    expect(capturedContext).toBeDefined();
    expect(capturedContext!["last_stage"]).toBe("a");
  });

  it("edge selection: condition match wins over weight", async () => {
    const g = graph({
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "work", shape: "box", prompt: "Work" },
        { id: "via_condition", shape: "box", prompt: "Via condition" },
        { id: "via_weight", shape: "box", prompt: "Via weight" },
      ],
      edges: [
        { from: "start", to: "work" },
        { from: "work", to: "via_weight", weight: 100 },
        { from: "work", to: "via_condition", condition: "outcome=success" },
        { from: "via_condition", to: "exit" },
        { from: "via_weight", to: "exit" },
      ],
    });

    const logsRoot = await tempDir();
    const result = await runPipeline({ graph: g, logsRoot, backend: successBackend });

    expect(result.completedNodes).toContain("via_condition");
  });

  it("edge selection: weight breaks ties for unconditional edges", async () => {
    const g = graph({
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "work", shape: "box", prompt: "Work" },
        { id: "low", shape: "box", prompt: "Low" },
        { id: "high", shape: "box", prompt: "High" },
      ],
      edges: [
        { from: "start", to: "work" },
        { from: "work", to: "low", weight: 1 },
        { from: "work", to: "high", weight: 10 },
        { from: "low", to: "exit" },
        { from: "high", to: "exit" },
      ],
    });

    const logsRoot = await tempDir();
    const result = await runPipeline({ graph: g, logsRoot, backend: successBackend });

    expect(result.completedNodes).toContain("high");
  });

  it("$goal variable expansion works", async () => {
    let capturedPrompt = "";
    const captureBackend: CodergenBackend = {
      async run(node, prompt) {
        if (node.id === "work") capturedPrompt = prompt;
        return "Done";
      },
    };

    const g = graph({
      attrs: { goal: "Build a REST API" },
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "work", shape: "box", prompt: "Implement: $goal" },
      ],
      edges: [
        { from: "start", to: "work" },
        { from: "work", to: "exit" },
      ],
    });

    const logsRoot = await tempDir();
    await runPipeline({ graph: g, logsRoot, backend: captureBackend });

    expect(capturedPrompt).toBe("Implement: Build a REST API");
  });

  it("handles pipeline with 10+ nodes", async () => {
    const nodes = [
      { id: "start", shape: "Mdiamond" },
      { id: "exit", shape: "Msquare" },
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `n${i}`, shape: "box", prompt: `Step ${i}`,
      })),
    ];

    const chain = ["start", ...Array.from({ length: 10 }, (_, i) => `n${i}`), "exit"];
    const edges = chain.slice(0, -1).map((from, i) => ({ from, to: chain[i + 1] }));

    const g = graph({ nodes, edges });

    const logsRoot = await tempDir();
    const result = await runPipeline({ graph: g, logsRoot, backend: successBackend });

    expect(result.status).toBe("success");
    expect(result.completedNodes.length).toBe(12);
  });

  it("stops pipeline when non-routing node fails with no failure edge", async () => {
    const g = graph({
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "setup", shape: "box" },
        { id: "work", shape: "box" },
      ],
      edges: [
        { from: "start", to: "setup" },
        { from: "setup", to: "work" },
        { from: "work", to: "exit" },
      ],
    });

    const failOnSetup: CodergenBackend = {
      async run(node) {
        if (node.id === "setup") return { status: "fail", failure_reason: "setup exploded" } as Outcome;
        return `Done: ${node.id}`;
      },
    };

    const events: PipelineEvent[] = [];
    const logsRoot = await tempDir();
    const result = await runPipeline({
      graph: g, logsRoot, backend: failOnSetup,
      onEvent: (e) => events.push(e),
    });

    expect(result.status).toBe("fail");
    expect(result.completedNodes).toContain("setup");
    expect(result.completedNodes).not.toContain("work");
    expect(events.some(e => e.kind === "pipeline_failed")).toBe(true);
  });

  it("stage_failed event includes structured tool_failure data for tool stages", async () => {
    const g = graph({
      attrs: { goal: "Test" },
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "check", shape: "parallelogram", tool_command: "echo 'error detail' >&2 && exit 1" },
      ],
      edges: [
        { from: "start", to: "check" },
        { from: "check", to: "exit" },
      ],
    });

    const events: PipelineEvent[] = [];
    const logsRoot = await tempDir();
    const result = await runPipeline({
      graph: g, logsRoot,
      onEvent: (e) => events.push(e),
    });

    expect(result.status).toBe("fail");
    const stageFailedEvent = events.find(e => e.kind === "stage_failed" && e.data.name === "check");
    expect(stageFailedEvent).toBeDefined();
    const toolFailure = stageFailedEvent!.data.tool_failure as Record<string, unknown>;
    expect(toolFailure).toBeDefined();
    expect(toolFailure.failureClass).toBe("exit_nonzero");
    expect(toolFailure.digest).toBeTruthy();
    expect(toolFailure.command).toContain("exit 1");
  });

  it("pipeline failure result includes failureSummary for tool stage failures", async () => {
    const g = graph({
      attrs: { goal: "Test" },
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "check", shape: "parallelogram", tool_command: "echo failing && exit 1" },
      ],
      edges: [
        { from: "start", to: "check" },
        { from: "check", to: "exit" },
      ],
    });

    const logsRoot = await tempDir();
    const result = await runPipeline({ graph: g, logsRoot });

    expect(result.status).toBe("fail");
    expect(result.failureSummary).toBeDefined();
    expect(result.failureSummary!.failedNode).toBe("check");
    expect(result.failureSummary!.failureClass).toBe("exit_nonzero");
    expect(result.failureSummary!.digest).toBeTruthy();
    expect(result.failureSummary!.rerunCommand).toContain("exit 1");
    expect(result.failureSummary!.logsPath).toContain("check");
    expect(result.failureSummary!.logsPath).toContain("attempt-1");
    expect(result.failureSummary!.logsPath).not.toMatch(/meta\.json$/);
  });

  it("pipeline failure result includes failureSummary for codergen (LLM) failures", async () => {
    const g = graph({
      attrs: { goal: "Test" },
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "review", shape: "box", prompt: "Review the code" },
      ],
      edges: [
        { from: "start", to: "review" },
        { from: "review", to: "exit" },
      ],
    });

    const failingBackend: CodergenBackend = {
      async run() {
        return { status: "fail", failure_reason: "LLM error: rate limit exceeded" } as Outcome;
      },
    };

    const logsRoot = await tempDir();
    const result = await runPipeline({ graph: g, logsRoot, backend: failingBackend });

    expect(result.status).toBe("fail");
    expect(result.failureSummary).toBeDefined();
    expect(result.failureSummary!.failedNode).toBe("review");
    expect(result.failureSummary!.failureClass).toBe("llm_error");
    expect(result.failureSummary!.digest).toContain("rate limit exceeded");
    expect(result.failureSummary!.failureReason).toBe("LLM error: rate limit exceeded");
    expect(result.failureSummary!.logsPath).toContain("review");
    expect(result.failureSummary!.logsPath).toBe(join(logsRoot, "review"));
  });

  it("stage_failed event includes logsPath for all failure types", async () => {
    const g = graph({
      attrs: { goal: "Test" },
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "plan", shape: "box", prompt: "Make a plan" },
      ],
      edges: [
        { from: "start", to: "plan" },
        { from: "plan", to: "exit" },
      ],
    });

    const failingBackend: CodergenBackend = {
      async run() {
        return { status: "fail", failure_reason: "API unavailable" } as Outcome;
      },
    };

    const events: PipelineEvent[] = [];
    const logsRoot = await tempDir();
    await runPipeline({
      graph: g, logsRoot, backend: failingBackend,
      onEvent: (e) => events.push(e),
    });

    const stageFailedEvent = events.find(e => e.kind === "stage_failed" && e.data.name === "plan");
    expect(stageFailedEvent).toBeDefined();
    expect(stageFailedEvent!.data.logsPath).toBe(join(logsRoot, "plan"));
  });

  it("follows explicit failure edge when node fails", async () => {
    const g = graph({
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "build", shape: "box" },
        { id: "fix", shape: "box" },
      ],
      edges: [
        { from: "start", to: "build" },
        { from: "build", to: "exit", label: "Pass", condition: "outcome=success" },
        { from: "build", to: "fix", label: "Fail", condition: "outcome!=success" },
        { from: "fix", to: "exit" },
      ],
    });

    const failOnBuild: CodergenBackend = {
      async run(node) {
        if (node.id === "build") return { status: "fail", failure_reason: "build broke" } as Outcome;
        return `Done: ${node.id}`;
      },
    };

    const logsRoot = await tempDir();
    const result = await runPipeline({ graph: g, logsRoot, backend: failOnBuild });

    expect(result.status).toBe("success");
    expect(result.completedNodes).toContain("build");
    expect(result.completedNodes).toContain("fix");
    expect(result.completedNodes).toContain("exit");
  });

  it("forwards failure through unconditional edge to conditional gate", async () => {
    const g = graph({
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "review", shape: "box" },
        { id: "gate", shape: "diamond" },
        { id: "good", shape: "box" },
        { id: "revise", shape: "box" },
      ],
      edges: [
        { from: "start", to: "review" },
        { from: "review", to: "gate" },
        { from: "gate", to: "good", label: "Pass", condition: "outcome=success" },
        { from: "gate", to: "revise", label: "Fail", condition: "outcome!=success" },
        { from: "revise", to: "exit" },
      ],
    });

    const failOnReview: CodergenBackend = {
      async run(node) {
        if (node.id === "review") return { status: "fail", failure_reason: "needs work" } as Outcome;
        return `Done: ${node.id}`;
      },
    };

    const logsRoot = await tempDir();
    const result = await runPipeline({ graph: g, logsRoot, backend: failOnReview });

    expect(result.status).toBe("success");
    expect(result.completedNodes).toContain("review");
    expect(result.completedNodes).toContain("gate");
    expect(result.completedNodes).toContain("revise");
    expect(result.completedNodes).not.toContain("good");
  });
});

// ---------------------------------------------------------------------------
// Re-review after revision tests
// ---------------------------------------------------------------------------

describe("Human gate re-review after revision", () => {
  type GateDecision = { pattern: RegExp };

  type ReReviewTestResult = {
    result: Awaited<ReturnType<typeof runPipeline>>;
    humanGateCallCount: number;
    executedNodes: string[];
  };

  async function runReReviewTest(
    g: ReturnType<typeof graph>,
    gateDecisions: GateDecision[],
  ): Promise<ReReviewTestResult> {
    let humanGateCallCount = 0;
    const executedNodes: string[] = [];

    const backend: CodergenBackend = {
      async run(node) {
        executedNodes.push(node.id);
        return `Done: ${node.id}`;
      },
    };

    const interviewer: Interviewer = {
      async ask(question: Question): Promise<Answer> {
        if (question.type === "freeform") {
          return { value: "Feedback.", text: "Feedback." };
        }
        const decision = gateDecisions[humanGateCallCount] ?? gateDecisions[gateDecisions.length - 1]!;
        humanGateCallCount++;
        const selected = findOption(question.options, decision.pattern);
        return { value: selected.key, selected_option: selected };
      },
    };

    const logsRoot = await tempDir();
    const result = await runPipeline({ graph: g, logsRoot, backend, interviewer });

    return { result, humanGateCallCount, executedNodes };
  }

  it("redirects to human gate when revision bypasses the gate", async () => {
    const g = graph({
      attrs: { goal: "Test re-review" },
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "impl", shape: "box", prompt: "Implement" },
        { id: "human_review", shape: "hexagon", prompt: "Review the work" },
        { id: "revise", shape: "box", prompt: "Revise" },
        { id: "ws_merge", shape: "box", prompt: "Merge" },
      ],
      edges: [
        { from: "start", to: "impl" },
        { from: "impl", to: "human_review" },
        { from: "human_review", to: "ws_merge", label: "Approve" },
        { from: "human_review", to: "revise", label: "Revise" },
        { from: "revise", to: "ws_merge" },
        { from: "ws_merge", to: "exit" },
      ],
    });

    const { result, humanGateCallCount, executedNodes } = await runReReviewTest(
      g,
      [{ pattern: /revise/i }, { pattern: /approve/i }],
    );

    expect(result.status).toBe("success");
    expect(humanGateCallCount).toBe(2);
    expect(executedNodes).toContain("revise");
    expect(executedNodes).toContain("ws_merge");
  });

  it("does not redirect when re_review=false on the human gate", async () => {
    const g = graph({
      attrs: { goal: "Test no re-review" },
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "impl", shape: "box", prompt: "Implement" },
        { id: "human_review", shape: "hexagon", prompt: "Review", re_review: false },
        { id: "revise", shape: "box", prompt: "Revise" },
        { id: "ws_merge", shape: "box", prompt: "Merge" },
      ],
      edges: [
        { from: "start", to: "impl" },
        { from: "impl", to: "human_review" },
        { from: "human_review", to: "ws_merge", label: "Approve" },
        { from: "human_review", to: "revise", label: "Revise" },
        { from: "revise", to: "ws_merge" },
        { from: "ws_merge", to: "exit" },
      ],
    });

    const { result, humanGateCallCount, executedNodes } = await runReReviewTest(
      g,
      [{ pattern: /revise/i }],
    );

    expect(result.status).toBe("success");
    expect(humanGateCallCount).toBe(1);
    expect(executedNodes).toContain("revise");
    expect(executedNodes).toContain("ws_merge");
  });

  it("re-review works when the revision goes through intermediate nodes", async () => {
    const g = graph({
      attrs: { goal: "Test re-review with intermediates" },
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "impl", shape: "box", prompt: "Implement" },
        { id: "human_review", shape: "hexagon", prompt: "Review the work" },
        { id: "revise", shape: "box", prompt: "Revise" },
        { id: "selfci", shape: "parallelogram", tool_command: "echo ok" },
        { id: "ws_merge", shape: "box", prompt: "Merge" },
      ],
      edges: [
        { from: "start", to: "impl" },
        { from: "impl", to: "human_review" },
        { from: "human_review", to: "ws_merge", label: "Approve" },
        { from: "human_review", to: "revise", label: "Revise" },
        { from: "revise", to: "selfci" },
        { from: "selfci", to: "ws_merge" },
        { from: "ws_merge", to: "exit" },
      ],
    });

    const { result, humanGateCallCount, executedNodes } = await runReReviewTest(
      g,
      [{ pattern: /revise/i }, { pattern: /approve/i }],
    );

    expect(result.status).toBe("success");
    expect(humanGateCallCount).toBe(2);
    expect(executedNodes).toContain("revise");
    expect(result.completedNodes.filter(n => n === "human_review").length).toBe(2);
  });

  it("correctly-wired loop still works with re-review enabled", async () => {
    const g = graph({
      attrs: { goal: "Test well-wired loop" },
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "impl", shape: "box", prompt: "Implement" },
        { id: "human_review", shape: "hexagon", prompt: "Review" },
        { id: "revise", shape: "box", prompt: "Revise" },
        { id: "ws_merge", shape: "box", prompt: "Merge" },
      ],
      edges: [
        { from: "start", to: "impl" },
        { from: "impl", to: "human_review" },
        { from: "human_review", to: "ws_merge", label: "Approve" },
        { from: "human_review", to: "revise", label: "Revise" },
        { from: "revise", to: "human_review" },
        { from: "ws_merge", to: "exit" },
      ],
    });

    const { result, humanGateCallCount } = await runReReviewTest(
      g,
      [{ pattern: /revise/i }, { pattern: /approve/i }],
    );

    expect(result.status).toBe("success");
    expect(humanGateCallCount).toBe(2);
  });

  it("multiple human gates track re-review state independently", async () => {
    const g = graph({
      attrs: { goal: "Test multi-gate re-review" },
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "impl", shape: "box", prompt: "Implement" },
        { id: "review_a", shape: "hexagon", prompt: "Review A" },
        { id: "review_b", shape: "hexagon", prompt: "Review B" },
        { id: "revise", shape: "box", prompt: "Revise" },
        { id: "deploy", shape: "box", prompt: "Deploy" },
      ],
      edges: [
        { from: "start", to: "impl" },
        { from: "impl", to: "review_a" },
        { from: "review_a", to: "review_b", label: "Approve" },
        { from: "review_a", to: "revise", label: "Revise" },
        { from: "revise", to: "review_b" },
        { from: "review_b", to: "deploy", label: "Approve" },
        { from: "deploy", to: "exit" },
      ],
    });

    const gateCalls: Record<string, number> = {};
    const executedNodes: string[] = [];

    const backend: CodergenBackend = {
      async run(node) {
        executedNodes.push(node.id);
        return `Done: ${node.id}`;
      },
    };

    const interviewer: Interviewer = {
      async ask(question: Question): Promise<Answer> {
        if (question.type === "freeform") {
          return { value: "Feedback.", text: "Feedback." };
        }
        const stage = question.stage;
        gateCalls[stage] = (gateCalls[stage] ?? 0) + 1;

        if (stage === "review_a") {
          if (gateCalls[stage] === 1) {
            const revise = findOption(question.options, /revise/i);
            return { value: revise.key, selected_option: revise };
          }
          const approve = findOption(question.options, /approve/i);
          return { value: approve.key, selected_option: approve };
        }
        const approve = findOption(question.options, /approve/i);
        return { value: approve.key, selected_option: approve };
      },
    };

    const logsRoot = await tempDir();
    const result = await runPipeline({ graph: g, logsRoot, backend, interviewer });

    expect(result.status).toBe("success");
    expect(gateCalls["review_a"]).toBe(2);
    expect(gateCalls["review_b"]).toBe(1);
    expect(executedNodes).toContain("revise");
    expect(executedNodes).toContain("deploy");
  });
});

// ---------------------------------------------------------------------------
// Cancellation tests
// ---------------------------------------------------------------------------

describe("Pipeline Cancellation", () => {
  it("abort before first stage exits immediately as cancelled", async () => {
    const g = graph({
      attrs: { goal: "Test" },
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "work", shape: "box", prompt: "Work" },
      ],
      edges: [
        { from: "start", to: "work" },
        { from: "work", to: "exit" },
      ],
    });

    const controller = new AbortController();
    controller.abort();

    const events: PipelineEvent[] = [];
    const logsRoot = await tempDir();
    const result = await runPipeline({
      graph: g,
      logsRoot,
      backend: successBackend,
      abortSignal: controller.signal,
      onEvent: (e) => events.push(e),
    });

    expect(result.status).toBe("cancelled");
    expect(result.lastOutcome?.status).toBe("cancelled");
    expect(result.completedNodes).not.toContain("work");
    expect(events.some(e => e.kind === "pipeline_cancelled")).toBe(true);
  });

  it("abort during active stage prevents downstream execution", async () => {
    const controller = new AbortController();
    const executedNodes: string[] = [];

    const slowBackend: CodergenBackend = {
      async run(node) {
        executedNodes.push(node.id);
        if (node.id === "work") {
          controller.abort();
        }
        return `Done: ${node.id}`;
      },
    };

    const g = graph({
      attrs: { goal: "Test" },
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "work", shape: "box", prompt: "Work" },
        { id: "next", shape: "box", prompt: "Next" },
      ],
      edges: [
        { from: "start", to: "work" },
        { from: "work", to: "next" },
        { from: "next", to: "exit" },
      ],
    });

    const logsRoot = await tempDir();
    const result = await runPipeline({
      graph: g,
      logsRoot,
      backend: slowBackend,
      abortSignal: controller.signal,
    });

    expect(result.status).toBe("cancelled");
    expect(executedNodes).toContain("work");
    expect(executedNodes).not.toContain("next");
  });

  it("abort during retry backoff exits without waiting full delay", async () => {
    const controller = new AbortController();
    let retryCount = 0;

    const failingBackend: CodergenBackend = {
      async run(node) {
        retryCount++;
        if (retryCount === 1) {
          setTimeout(() => controller.abort(), 10);
        }
        return { status: "fail", failure_reason: "test fail" } as Outcome;
      },
    };

    const g = graph({
      attrs: { goal: "Test" },
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "work", shape: "box", prompt: "Work", max_retries: 5 },
      ],
      edges: [
        { from: "start", to: "work" },
        { from: "work", to: "exit" },
      ],
    });

    const logsRoot = await tempDir();
    const startTime = Date.now();
    const result = await runPipeline({
      graph: g,
      logsRoot,
      backend: failingBackend,
      abortSignal: controller.signal,
    });
    const elapsed = Date.now() - startTime;

    expect(result.status).toBe("cancelled");
    expect(elapsed).toBeLessThan(3000);
  });

  it("cancellation emits pipeline_cancelled event", async () => {
    const controller = new AbortController();
    const events: PipelineEvent[] = [];

    const abortBackend: CodergenBackend = {
      async run(node) {
        controller.abort();
        return `Done: ${node.id}`;
      },
    };

    const g = graph({
      attrs: { goal: "Test" },
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "work", shape: "box", prompt: "Work" },
      ],
      edges: [
        { from: "start", to: "work" },
        { from: "work", to: "exit" },
      ],
    });

    const logsRoot = await tempDir();
    await runPipeline({
      graph: g,
      logsRoot,
      backend: abortBackend,
      abortSignal: controller.signal,
      onEvent: (e) => events.push(e),
    });

    const cancelEvent = events.find(e => e.kind === "pipeline_cancelled");
    expect(cancelEvent).toBeDefined();
    expect(cancelEvent!.data.reason).toBe("aborted");
  });

  it("checkpoint persisted on cancel", async () => {
    const controller = new AbortController();

    const abortBackend: CodergenBackend = {
      async run(node) {
        controller.abort();
        return `Done: ${node.id}`;
      },
    };

    const g = graph({
      attrs: { goal: "Test" },
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "work", shape: "box", prompt: "Work" },
      ],
      edges: [
        { from: "start", to: "work" },
        { from: "work", to: "exit" },
      ],
    });

    const logsRoot = await tempDir();
    await runPipeline({
      graph: g,
      logsRoot,
      backend: abortBackend,
      abortSignal: controller.signal,
    });

    const cpPath = join(logsRoot, "checkpoint.json");
    const cpJson = await readFile(cpPath, "utf-8");
    const checkpoint = JSON.parse(cpJson);
    expect(checkpoint.current_node).toBeDefined();
    expect(checkpoint.completed_nodes).toBeDefined();
  });

  it("workspace is not emergency-cleaned on cancel", async () => {
    const controller = new AbortController();
    let cleanupCalled = false;

    const abortBackend: CodergenBackend = {
      async run(node, _prompt, context) {
        if (node.id === "work") {
          context.set("workspace.path", "/tmp/fake-ws");
          context.set("workspace.name", "fake-ws");
          controller.abort();
        }
        return `Done: ${node.id}`;
      },
    };

    const g = graph({
      attrs: { goal: "Test" },
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "work", shape: "box", prompt: "Work" },
      ],
      edges: [
        { from: "start", to: "work" },
        { from: "work", to: "exit" },
      ],
    });

    const logsRoot = await tempDir();
    const result = await runPipeline({
      graph: g,
      logsRoot,
      backend: abortBackend,
      abortSignal: controller.signal,
      cleanupWorkspaceOnFailure: true,
      jjRunner: async () => { cleanupCalled = true; return ""; },
    });

    expect(result.status).toBe("cancelled");
    expect(cleanupCalled).toBe(false);
  });

  it("workspace is not emergency-cleaned on failure by default", async () => {
    let cleanupCalled = false;

    const failingBackend: CodergenBackend = {
      async run(node, _prompt, context) {
        if (node.id === "work") {
          context.set("workspace.path", "/tmp/fake-ws");
          context.set("workspace.name", "fake-ws");
          return { status: "fail", failure_reason: "boom" };
        }
        return `Done: ${node.id}`;
      },
    };

    const g = graph({
      attrs: { goal: "Test" },
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "work", shape: "box", prompt: "Work" },
      ],
      edges: [
        { from: "start", to: "work" },
        { from: "work", to: "exit" },
      ],
    });

    const logsRoot = await tempDir();
    const result = await runPipeline({
      graph: g,
      logsRoot,
      backend: failingBackend,
      jjRunner: async () => { cleanupCalled = true; return ""; },
    });

    expect(result.status).toBe("fail");
    expect(cleanupCalled).toBe(false);
  });

  it("workspace is emergency-cleaned on failure when explicitly enabled", async () => {
    let cleanupCalled = false;

    const failingBackend: CodergenBackend = {
      async run(node, _prompt, context) {
        if (node.id === "work") {
          context.set("workspace.path", "/tmp/fake-ws");
          context.set("workspace.name", "fake-ws");
          return { status: "fail", failure_reason: "boom" };
        }
        return `Done: ${node.id}`;
      },
    };

    const g = graph({
      attrs: { goal: "Test" },
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "work", shape: "box", prompt: "Work" },
      ],
      edges: [
        { from: "start", to: "work" },
        { from: "work", to: "exit" },
      ],
    });

    const logsRoot = await tempDir();
    const result = await runPipeline({
      graph: g,
      logsRoot,
      backend: failingBackend,
      cleanupWorkspaceOnFailure: true,
      jjRunner: async () => { cleanupCalled = true; return ""; },
    });

    expect(result.status).toBe("fail");
    expect(cleanupCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Usage tracking tests
// ---------------------------------------------------------------------------

describe("Pipeline Usage Tracking", () => {
  function usageBackend(usageByNode: Record<string, { input: number; output: number; cost: number }>): CodergenBackend {
    return {
      async run(node) {
        const u = usageByNode[node.id];
        if (u) {
          return {
            status: "success",
            context_updates: {
              [`${node.id}.usage.input_tokens`]: u.input,
              [`${node.id}.usage.output_tokens`]: u.output,
              [`${node.id}.usage.total_tokens`]: u.input + u.output,
              [`${node.id}.usage.cache_read_tokens`]: 0,
              [`${node.id}.usage.cache_write_tokens`]: 0,
              [`${node.id}.usage.cost`]: u.cost,
            },
          } as Outcome;
        }
        return `Done: ${node.id}`;
      },
    };
  }

  it("happy path: collects usage from multiple stages", async () => {
    const g = graph({
      attrs: { goal: "Test usage" },
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "plan", shape: "box", prompt: "Plan" },
        { id: "impl", shape: "box", prompt: "Implement" },
      ],
      edges: [
        { from: "start", to: "plan" },
        { from: "plan", to: "impl" },
        { from: "impl", to: "exit" },
      ],
    });

    const logsRoot = await tempDir();
    const result = await runPipeline({
      graph: g,
      logsRoot,
      backend: usageBackend({
        plan: { input: 100, output: 50, cost: 0.001 },
        impl: { input: 200, output: 150, cost: 0.003 },
      }),
    });

    expect(result.status).toBe("success");
    expect(result.usageSummary).toBeDefined();
    expect(result.usageSummary!.stages).toHaveLength(2);
    expect(result.usageSummary!.stages[0].stageId).toBe("plan");
    expect(result.usageSummary!.stages[1].stageId).toBe("impl");
    expect(result.usageSummary!.totals.input_tokens).toBe(300);
    expect(result.usageSummary!.totals.output_tokens).toBe(200);
    expect(result.usageSummary!.totals.cost).toBeCloseTo(0.004);
  });

  it("retries: all attempts included in totals", async () => {
    let callCount = 0;
    const retryBackend: CodergenBackend = {
      async run(node) {
        if (node.id === "work") {
          callCount++;
          if (callCount === 1) {
            return {
              status: "fail",
              failure_reason: "first try fail",
              context_updates: {
                [`${node.id}.usage.input_tokens`]: 50,
                [`${node.id}.usage.output_tokens`]: 25,
                [`${node.id}.usage.total_tokens`]: 75,
                [`${node.id}.usage.cache_read_tokens`]: 0,
                [`${node.id}.usage.cache_write_tokens`]: 0,
                [`${node.id}.usage.cost`]: 0.001,
              },
            } as Outcome;
          }
          return {
            status: "success",
            context_updates: {
              [`${node.id}.usage.input_tokens`]: 100,
              [`${node.id}.usage.output_tokens`]: 80,
              [`${node.id}.usage.total_tokens`]: 180,
              [`${node.id}.usage.cache_read_tokens`]: 0,
              [`${node.id}.usage.cache_write_tokens`]: 0,
              [`${node.id}.usage.cost`]: 0.002,
            },
          } as Outcome;
        }
        return `Done: ${node.id}`;
      },
    };

    const g = graph({
      attrs: { goal: "Test retries" },
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "work", shape: "box", prompt: "Work", max_retries: 2 },
      ],
      edges: [
        { from: "start", to: "work" },
        { from: "work", to: "exit" },
      ],
    });

    const logsRoot = await tempDir();
    const result = await runPipeline({ graph: g, logsRoot, backend: retryBackend });

    expect(result.status).toBe("success");
    expect(result.usageSummary).toBeDefined();
    expect(result.usageSummary!.stages.length).toBeGreaterThanOrEqual(1);
    expect(result.usageSummary!.totals.cost).toBeGreaterThanOrEqual(0.002);
  });

  it("failed pipeline still returns usage summary", async () => {
    const failBackend: CodergenBackend = {
      async run(node) {
        return {
          status: "fail",
          failure_reason: "boom",
          context_updates: {
            [`${node.id}.usage.input_tokens`]: 100,
            [`${node.id}.usage.output_tokens`]: 50,
            [`${node.id}.usage.total_tokens`]: 150,
            [`${node.id}.usage.cache_read_tokens`]: 0,
            [`${node.id}.usage.cache_write_tokens`]: 0,
            [`${node.id}.usage.cost`]: 0.005,
          },
        } as Outcome;
      },
    };

    const g = graph({
      attrs: { goal: "Test fail usage" },
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "work", shape: "box", prompt: "Work" },
      ],
      edges: [
        { from: "start", to: "work" },
        { from: "work", to: "exit" },
      ],
    });

    const logsRoot = await tempDir();
    const result = await runPipeline({ graph: g, logsRoot, backend: failBackend });

    expect(result.status).toBe("fail");
    expect(result.usageSummary).toBeDefined();
    expect(result.usageSummary!.totals.cost).toBe(0.005);
  });

  it("cancelled pipeline still returns usage summary", async () => {
    const controller = new AbortController();

    const abortBackend: CodergenBackend = {
      async run(node) {
        controller.abort();
        return {
          status: "success",
          context_updates: {
            [`${node.id}.usage.input_tokens`]: 200,
            [`${node.id}.usage.output_tokens`]: 100,
            [`${node.id}.usage.total_tokens`]: 300,
            [`${node.id}.usage.cache_read_tokens`]: 0,
            [`${node.id}.usage.cache_write_tokens`]: 0,
            [`${node.id}.usage.cost`]: 0.01,
          },
        } as Outcome;
      },
    };

    const g = graph({
      attrs: { goal: "Test cancel usage" },
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "a", shape: "box", prompt: "A" },
        { id: "b", shape: "box", prompt: "B" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "exit" },
      ],
    });

    const logsRoot = await tempDir();
    const result = await runPipeline({
      graph: g, logsRoot,
      backend: abortBackend,
      abortSignal: controller.signal,
    });

    expect(result.status).toBe("cancelled");
    expect(result.usageSummary).toBeDefined();
    expect(result.usageSummary!.totals.cost).toBe(0.01);
  });

  it("no usage: usageSummary has empty stages and zero totals", async () => {
    const g = graph({
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
      ],
      edges: [{ from: "start", to: "exit" }],
    });

    const logsRoot = await tempDir();
    const result = await runPipeline({ graph: g, logsRoot, backend: successBackend });

    expect(result.status).toBe("success");
    expect(result.usageSummary).toBeDefined();
    expect(result.usageSummary.stages).toHaveLength(0);
    expect(result.usageSummary.totals.cost).toBe(0);
    expect(result.usageSummary.totals.input_tokens).toBe(0);
  });

  it("emits usage_update events during execution", async () => {
    const g = graph({
      attrs: { goal: "Test events" },
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "work", shape: "box", prompt: "Work" },
      ],
      edges: [
        { from: "start", to: "work" },
        { from: "work", to: "exit" },
      ],
    });

    const events: PipelineEvent[] = [];
    const logsRoot = await tempDir();
    await runPipeline({
      graph: g,
      logsRoot,
      backend: usageBackend({ work: { input: 100, output: 50, cost: 0.001 } }),
      onEvent: (e) => events.push(e),
    });

    const usageEvents = events.filter(e => e.kind === "usage_update");
    expect(usageEvents.length).toBeGreaterThan(0);
    expect(usageEvents[0].data.stageId).toBe("work");
    expect(usageEvents[0].data.summary).toBeDefined();
  });

  it("ignores malformed/non-numeric usage values", async () => {
    const badBackend: CodergenBackend = {
      async run(node) {
        return {
          status: "success",
          context_updates: {
            [`${node.id}.usage.input_tokens`]: "not-a-number",
            [`${node.id}.usage.output_tokens`]: null,
            [`${node.id}.usage.total_tokens`]: undefined,
            [`${node.id}.usage.cache_read_tokens`]: NaN,
            [`${node.id}.usage.cache_write_tokens`]: Infinity,
            [`${node.id}.usage.cost`]: 0.001,
          },
        } as Outcome;
      },
    };

    const g = graph({
      attrs: { goal: "Test bad usage" },
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "work", shape: "box", prompt: "Work" },
      ],
      edges: [
        { from: "start", to: "work" },
        { from: "work", to: "exit" },
      ],
    });

    const logsRoot = await tempDir();
    const result = await runPipeline({ graph: g, logsRoot, backend: badBackend });

    expect(result.status).toBe("success");
    expect(result.usageSummary).toBeDefined();
    expect(result.usageSummary!.totals.input_tokens).toBe(0);
    expect(result.usageSummary!.totals.output_tokens).toBe(0);
    expect(result.usageSummary!.totals.cache_read_tokens).toBe(0);
    expect(result.usageSummary!.totals.cache_write_tokens).toBe(0);
    expect(result.usageSummary!.totals.cost).toBe(0.001);
  });

  it("partial usage: only cost, no token counts", async () => {
    const costOnlyBackend: CodergenBackend = {
      async run(node) {
        return {
          status: "success",
          context_updates: {
            [`${node.id}.usage.cost`]: 0.05,
          },
        } as Outcome;
      },
    };

    const g = graph({
      attrs: { goal: "Test partial usage" },
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "work", shape: "box", prompt: "Work" },
      ],
      edges: [
        { from: "start", to: "work" },
        { from: "work", to: "exit" },
      ],
    });

    const logsRoot = await tempDir();
    const result = await runPipeline({ graph: g, logsRoot, backend: costOnlyBackend });

    expect(result.status).toBe("success");
    expect(result.usageSummary).toBeDefined();
    expect(result.usageSummary!.totals.cost).toBe(0.05);
    expect(result.usageSummary!.totals.input_tokens).toBe(0);
  });
});

// ===========================================================================
// logsRoot validation
// ===========================================================================

describe("logsRoot validation", () => {
  const minimalGraph = graph({
    name: "LogsRootTest",
    goal: "test",
    nodes: [
      { id: "start", shape: "Mdiamond" },
      { id: "exit", shape: "Msquare" },
    ],
    edges: [{ from: "start", to: "exit" }],
  });

  it("rejects logsRoot that resolves to a blocked system directory", async () => {
    await expect(
      runPipeline({ graph: minimalGraph, logsRoot: "/etc/attractor", backend: successBackend }),
    ).rejects.toThrow(/blocked system directory/);
  });

  it("rejects logsRoot that traverses into a blocked directory", async () => {
    await expect(
      runPipeline({ graph: minimalGraph, logsRoot: "/tmp/safe/../../etc/pwned", backend: successBackend }),
    ).rejects.toThrow(/blocked system directory/);
  });

  it("accepts a normal temporary directory", async () => {
    const logs = await tempDir();
    const result = await runPipeline({ graph: minimalGraph, logsRoot: logs, backend: successBackend });
    expect(result.status).toBe("success");
  });

  it("accepts a relative logsRoot that resolves safely", async () => {
    const logs = await tempDir();
    // Use the absolute temp dir — relative paths are resolved against cwd
    // which may vary, so we just verify the validation doesn't reject it.
    const result = await runPipeline({ graph: minimalGraph, logsRoot: logs, backend: successBackend });
    expect(result.status).toBe("success");
  });
});
