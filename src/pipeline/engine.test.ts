import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, readFile, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { runPipeline } from "./engine.js";
import { parseDot } from "./dot-parser.js";
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
    const graph = parseDot(`
      digraph Test {
        graph [goal="Test"]
        start [shape=Mdiamond]
        exit [shape=Msquare]
        work [shape=box, prompt="Do work"]
        start -> work -> exit
      }
    `);

    const logsRoot = await tempDir();
    const result = await runPipeline({ graph, logsRoot, backend: successBackend });

    expect(result.status).toBe("success");
    expect(result.completedNodes).toContain("start");
    expect(result.completedNodes).toContain("work");
    expect(result.completedNodes).toContain("exit");
  });

  it("writes artifacts to log directory", async () => {
    const graph = parseDot(`
      digraph Test {
        graph [goal="Test artifacts"]
        start [shape=Mdiamond]
        exit [shape=Msquare]
        plan [shape=box, prompt="Plan the work"]
        start -> plan -> exit
      }
    `);

    const logsRoot = await tempDir();
    await runPipeline({ graph, logsRoot, backend: successBackend });

    const promptFile = await readFile(join(logsRoot, "plan", "prompt.md"), "utf-8");
    expect(promptFile).toBe("Plan the work");

    const responseFile = await readFile(join(logsRoot, "plan", "response.md"), "utf-8");
    expect(responseFile).toContain("Completed: plan");

    const statusFile = await readFile(join(logsRoot, "plan", "status.json"), "utf-8");
    const status = JSON.parse(statusFile);
    expect(status.outcome).toBe("success");
  });

  it("executes conditional branching (success/fail paths)", async () => {
    const graph = parseDot(`
      digraph Test {
        graph [goal="Test branching"]
        start [shape=Mdiamond]
        exit [shape=Msquare]
        work [shape=box, prompt="Do work"]
        gate [shape=diamond]
        fix [shape=box, prompt="Fix issues"]

        start -> work -> gate
        gate -> exit [condition="outcome=success"]
        gate -> fix [condition="outcome!=success"]
        fix -> exit
      }
    `);

    const logsRoot = await tempDir();
    const result = await runPipeline({ graph, logsRoot, backend: successBackend });

    expect(result.status).toBe("success");
    // Conditional handler returns success, so gate -> exit
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

    const graph = parseDot(`
      digraph Test {
        graph [goal="Test goal gate"]
        start [shape=Mdiamond]
        exit [shape=Msquare]
        implement [shape=box, prompt="Implement", goal_gate=true]

        start -> implement -> exit
      }
    `);

    const logsRoot = await tempDir();
    const result = await runPipeline({ graph, logsRoot, backend: failingBackend });

    // Goal gate not satisfied → pipeline fails
    expect(result.status).toBe("fail");
  });

  it("emits events during execution", async () => {
    const graph = parseDot(`
      digraph Test {
        start [shape=Mdiamond]
        exit [shape=Msquare]
        work [shape=box, prompt="Work"]
        start -> work -> exit
      }
    `);

    const events: PipelineEvent[] = [];
    const logsRoot = await tempDir();
    await runPipeline({
      graph,
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

  it("saves and can resume from checkpoints", async () => {
    const graph = parseDot(`
      digraph Test {
        start [shape=Mdiamond]
        exit [shape=Msquare]
        a [shape=box, prompt="A"]
        b [shape=box, prompt="B"]
        start -> a -> b -> exit
      }
    `);

    const logsRoot = await tempDir();
    await runPipeline({ graph, logsRoot, backend: successBackend });

    // Verify checkpoint was written
    const cpJson = await readFile(join(logsRoot, "checkpoint.json"), "utf-8");
    const checkpoint = JSON.parse(cpJson);
    expect(checkpoint.completed_nodes.length).toBeGreaterThan(0);

    // Resume from checkpoint
    const logsRoot2 = await tempDir();
    const result2 = await runPipeline({ graph, logsRoot: logsRoot2, backend: successBackend, checkpoint });
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

    const graph = parseDot(`
      digraph Test {
        start [shape=Mdiamond]
        exit [shape=Msquare]
        a [shape=box, prompt="A"]
        b [shape=box, prompt="B"]
        start -> a -> b -> exit
      }
    `);

    const logsRoot = await tempDir();
    await runPipeline({ graph, logsRoot, backend: contextBackend });

    expect(capturedContext).toBeDefined();
    expect(capturedContext!["last_stage"]).toBe("a");
  });

  it("edge selection: condition match wins over weight", async () => {
    const graph = parseDot(`
      digraph Test {
        start [shape=Mdiamond]
        exit [shape=Msquare]
        work [shape=box, prompt="Work"]
        via_condition [shape=box, prompt="Via condition"]
        via_weight [shape=box, prompt="Via weight"]

        start -> work
        work -> via_weight [weight=100]
        work -> via_condition [condition="outcome=success"]
        via_condition -> exit
        via_weight -> exit
      }
    `);

    const logsRoot = await tempDir();
    const result = await runPipeline({ graph, logsRoot, backend: successBackend });

    // Condition match should win
    expect(result.completedNodes).toContain("via_condition");
  });

  it("edge selection: weight breaks ties for unconditional edges", async () => {
    const graph = parseDot(`
      digraph Test {
        start [shape=Mdiamond]
        exit [shape=Msquare]
        work [shape=box, prompt="Work"]
        low [shape=box, prompt="Low"]
        high [shape=box, prompt="High"]

        start -> work
        work -> low [weight=1]
        work -> high [weight=10]
        low -> exit
        high -> exit
      }
    `);

    const logsRoot = await tempDir();
    const result = await runPipeline({ graph, logsRoot, backend: successBackend });

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

    const graph = parseDot(`
      digraph Test {
        graph [goal="Build a REST API"]
        start [shape=Mdiamond]
        exit [shape=Msquare]
        work [shape=box, prompt="Implement: $goal"]
        start -> work -> exit
      }
    `);

    const logsRoot = await tempDir();
    await runPipeline({ graph, logsRoot, backend: captureBackend });

    expect(capturedPrompt).toBe("Implement: Build a REST API");
  });

  it("handles pipeline with 10+ nodes", async () => {
    const nodeDecls = Array.from({ length: 10 }, (_, i) =>
      `n${i} [shape=box, prompt="Step ${i}"]`
    ).join("\n");
    const chain = ["start", ...Array.from({ length: 10 }, (_, i) => `n${i}`), "exit"].join(" -> ");

    const graph = parseDot(`
      digraph Big {
        start [shape=Mdiamond]
        exit [shape=Msquare]
        ${nodeDecls}
        ${chain}
      }
    `);

    const logsRoot = await tempDir();
    const result = await runPipeline({ graph, logsRoot, backend: successBackend });

    expect(result.status).toBe("success");
    expect(result.completedNodes.length).toBe(12); // start + 10 nodes + exit
  });

  it("stops pipeline when non-routing node fails with no failure edge", async () => {
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        setup [shape=box]
        work  [shape=box]
        start -> setup
        setup -> work
        work  -> exit
      }
    `);

    const failOnSetup: CodergenBackend = {
      async run(node) {
        if (node.id === "setup") return { status: "fail", failure_reason: "setup exploded" } as Outcome;
        return `Done: ${node.id}`;
      },
    };

    const events: PipelineEvent[] = [];
    const logsRoot = await tempDir();
    const result = await runPipeline({
      graph, logsRoot, backend: failOnSetup,
      onEvent: (e) => events.push(e),
    });

    expect(result.status).toBe("fail");
    // Pipeline should stop at setup, not continue to work
    expect(result.completedNodes).toContain("setup");
    expect(result.completedNodes).not.toContain("work");
    expect(events.some(e => e.kind === "pipeline_failed")).toBe(true);
  });

  it("stage_failed event includes structured tool_failure data for tool stages", async () => {
    const graph = parseDot(`
      digraph G {
        graph [goal="Test"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        check [shape=parallelogram, tool_command="echo 'error detail' >&2 && exit 1"]
        start -> check
        check -> exit
      }
    `);

    const events: PipelineEvent[] = [];
    const logsRoot = await tempDir();
    const result = await runPipeline({
      graph, logsRoot,
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
    const graph = parseDot(`
      digraph G {
        graph [goal="Test"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        check [shape=parallelogram, tool_command="echo failing && exit 1"]
        start -> check
        check -> exit
      }
    `);

    const logsRoot = await tempDir();
    const result = await runPipeline({ graph, logsRoot });

    expect(result.status).toBe("fail");
    expect(result.failureSummary).toBeDefined();
    expect(result.failureSummary!.failedNode).toBe("check");
    expect(result.failureSummary!.failureClass).toBe("exit_nonzero");
    expect(result.failureSummary!.digest).toBeTruthy();
    expect(result.failureSummary!.rerunCommand).toContain("exit 1");
    // logsPath should be the specific attempt directory, not the root
    expect(result.failureSummary!.logsPath).toContain("check");
    expect(result.failureSummary!.logsPath).toContain("attempt-1");
    expect(result.failureSummary!.logsPath).not.toMatch(/meta\.json$/);
  });

  it("pipeline failure result includes failureSummary for codergen (LLM) failures", async () => {
    const graph = parseDot(`
      digraph G {
        graph [goal="Test"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        review [shape=box, prompt="Review the code"]
        start -> review
        review -> exit
      }
    `);

    const failingBackend: CodergenBackend = {
      async run() {
        return { status: "fail", failure_reason: "LLM error: rate limit exceeded" } as Outcome;
      },
    };

    const logsRoot = await tempDir();
    const result = await runPipeline({ graph, logsRoot, backend: failingBackend });

    expect(result.status).toBe("fail");
    expect(result.failureSummary).toBeDefined();
    expect(result.failureSummary!.failedNode).toBe("review");
    expect(result.failureSummary!.failureClass).toBe("llm_error");
    expect(result.failureSummary!.digest).toContain("rate limit exceeded");
    expect(result.failureSummary!.failureReason).toBe("LLM error: rate limit exceeded");
    // logsPath should point to the node's log directory
    expect(result.failureSummary!.logsPath).toContain("review");
    expect(result.failureSummary!.logsPath).toBe(join(logsRoot, "review"));
  });

  it("stage_failed event includes logsPath for all failure types", async () => {
    const graph = parseDot(`
      digraph G {
        graph [goal="Test"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        plan [shape=box, prompt="Make a plan"]
        start -> plan
        plan -> exit
      }
    `);

    const failingBackend: CodergenBackend = {
      async run() {
        return { status: "fail", failure_reason: "API unavailable" } as Outcome;
      },
    };

    const events: PipelineEvent[] = [];
    const logsRoot = await tempDir();
    await runPipeline({
      graph, logsRoot, backend: failingBackend,
      onEvent: (e) => events.push(e),
    });

    const stageFailedEvent = events.find(e => e.kind === "stage_failed" && e.data.name === "plan");
    expect(stageFailedEvent).toBeDefined();
    expect(stageFailedEvent!.data.logsPath).toBe(join(logsRoot, "plan"));
  });

  it("follows explicit failure edge when node fails", async () => {
    const graph = parseDot(`
      digraph G {
        start   [shape=Mdiamond]
        exit    [shape=Msquare]
        build   [shape=box]
        fix     [shape=box]
        start   -> build
        build   -> exit  [label="Pass", condition="outcome=success"]
        build   -> fix   [label="Fail", condition="outcome!=success"]
        fix     -> exit
      }
    `);

    const failOnBuild: CodergenBackend = {
      async run(node) {
        if (node.id === "build") return { status: "fail", failure_reason: "build broke" } as Outcome;
        return `Done: ${node.id}`;
      },
    };

    const logsRoot = await tempDir();
    const result = await runPipeline({ graph, logsRoot, backend: failOnBuild });

    expect(result.status).toBe("success");
    expect(result.completedNodes).toContain("build");
    expect(result.completedNodes).toContain("fix");
    expect(result.completedNodes).toContain("exit");
  });

  it("forwards failure through unconditional edge to conditional gate", async () => {
    // Pattern: review → gate (diamond) → implement | revise
    // When review returns fail, the unconditional edge to the gate should
    // still be followed because the gate routes based on outcome.
    const graph = parseDot(`
      digraph G {
        start   [shape=Mdiamond]
        exit    [shape=Msquare]
        review  [shape=box]
        gate    [shape=diamond]
        good    [shape=box]
        revise  [shape=box]
        start   -> review
        review  -> gate
        gate    -> good   [label="Pass", condition="outcome=success"]
        gate    -> revise [label="Fail", condition="outcome!=success"]
        revise  -> exit
      }
    `);

    const failOnReview: CodergenBackend = {
      async run(node) {
        if (node.id === "review") return { status: "fail", failure_reason: "needs work" } as Outcome;
        return `Done: ${node.id}`;
      },
    };

    const logsRoot = await tempDir();
    const result = await runPipeline({ graph, logsRoot, backend: failOnReview });

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
  /** Decision sequence for the gate interviewer: pick options by label pattern in order. */
  type GateDecision = { pattern: RegExp };

  type ReReviewTestResult = {
    result: Awaited<ReturnType<typeof runPipeline>>;
    humanGateCallCount: number;
    executedNodes: string[];
  };

  /**
   * Shared harness for re-review tests.
   *
   * Runs a pipeline with a tracking backend and a gate interviewer that picks
   * options from `gateDecisions` in sequence (freeform questions always get
   * an automatic text reply).
   */
  async function runReReviewTest(
    dot: string,
    gateDecisions: GateDecision[],
  ): Promise<ReReviewTestResult> {
    const graph = parseDot(dot);
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
    const result = await runPipeline({ graph, logsRoot, backend, interviewer });

    return { result, humanGateCallCount, executedNodes };
  }

  it("redirects to human gate when revision bypasses the gate", async () => {
    // Revision goes directly to the approve target (ws_merge), skipping the
    // human gate. The engine should intercept and redirect.
    const { result, humanGateCallCount, executedNodes } = await runReReviewTest(
      `digraph G {
        graph [goal="Test re-review"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        impl  [shape=box, prompt="Implement"]
        human_review [shape=hexagon, prompt="Review the work"]
        revise [shape=box, prompt="Revise"]
        ws_merge [shape=box, prompt="Merge"]

        start -> impl -> human_review
        human_review -> ws_merge [label="Approve"]
        human_review -> revise   [label="Revise"]
        revise -> ws_merge
        ws_merge -> exit
      }`,
      [{ pattern: /revise/i }, { pattern: /approve/i }],
    );

    expect(result.status).toBe("success");
    expect(humanGateCallCount).toBe(2);
    expect(executedNodes).toContain("revise");
    expect(executedNodes).toContain("ws_merge");
  });

  it("does not redirect when re_review=false on the human gate", async () => {
    const { result, humanGateCallCount, executedNodes } = await runReReviewTest(
      `digraph G {
        graph [goal="Test no re-review"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        impl  [shape=box, prompt="Implement"]
        human_review [shape=hexagon, prompt="Review", re_review=false]
        revise [shape=box, prompt="Revise"]
        ws_merge [shape=box, prompt="Merge"]

        start -> impl -> human_review
        human_review -> ws_merge [label="Approve"]
        human_review -> revise   [label="Revise"]
        revise -> ws_merge
        ws_merge -> exit
      }`,
      [{ pattern: /revise/i }],
    );

    expect(result.status).toBe("success");
    // Human gate should only be visited once — no re-review redirect
    expect(humanGateCallCount).toBe(1);
    // revise ran and ws_merge was reached directly (no redirection)
    expect(executedNodes).toContain("revise");
    expect(executedNodes).toContain("ws_merge");
  });

  it("re-review works when the revision goes through intermediate nodes", async () => {
    // human_review -> revise -> selfci -> ws_merge
    // selfci is intermediate; ws_merge is the approve target.
    const { result, humanGateCallCount, executedNodes } = await runReReviewTest(
      `digraph G {
        graph [goal="Test re-review with intermediates"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        impl  [shape=box, prompt="Implement"]
        human_review [shape=hexagon, prompt="Review the work"]
        revise [shape=box, prompt="Revise"]
        selfci [shape=parallelogram, tool_command="echo ok"]
        ws_merge [shape=box, prompt="Merge"]

        start -> impl -> human_review
        human_review -> ws_merge [label="Approve"]
        human_review -> revise   [label="Revise"]
        revise -> selfci
        selfci -> ws_merge
        ws_merge -> exit
      }`,
      [{ pattern: /revise/i }, { pattern: /approve/i }],
    );

    expect(result.status).toBe("success");
    expect(humanGateCallCount).toBe(2);
    expect(executedNodes).toContain("revise");
    expect(result.completedNodes.filter(n => n === "human_review").length).toBe(2);
  });

  it("correctly-wired loop still works with re-review enabled", async () => {
    // Revision already loops back through the human gate.
    // Re-review should not interfere.
    const { result, humanGateCallCount } = await runReReviewTest(
      `digraph G {
        graph [goal="Test well-wired loop"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        impl  [shape=box, prompt="Implement"]
        human_review [shape=hexagon, prompt="Review"]
        revise [shape=box, prompt="Revise"]
        ws_merge [shape=box, prompt="Merge"]

        start -> impl -> human_review
        human_review -> ws_merge [label="Approve"]
        human_review -> revise   [label="Revise"]
        revise -> human_review
        ws_merge -> exit
      }`,
      [{ pattern: /revise/i }, { pattern: /approve/i }],
    );

    expect(result.status).toBe("success");
    // Still visited twice — the natural loop and re-review don't conflict
    expect(humanGateCallCount).toBe(2);
  });

  it("multiple human gates track re-review state independently", async () => {
    // Two sequential human gates (review_a, review_b). Reviewer chooses
    // Revise at gate A, then the revision path passes through gate B
    // (which approves). The engine must still enforce re-review for gate A
    // even though gate B has already run.
    const graph = parseDot(`
      digraph G {
        graph [goal="Test multi-gate re-review"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        impl     [shape=box, prompt="Implement"]
        review_a [shape=hexagon, prompt="Review A"]
        review_b [shape=hexagon, prompt="Review B"]
        revise   [shape=box, prompt="Revise"]
        deploy   [shape=box, prompt="Deploy"]

        start -> impl -> review_a
        review_a -> review_b [label="Approve"]
        review_a -> revise   [label="Revise"]
        revise -> review_b
        review_b -> deploy [label="Approve"]
        deploy -> exit
      }
    `);

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
        // Determine which gate is asking by the prompt text
        const stage = question.stage;
        gateCalls[stage] = (gateCalls[stage] ?? 0) + 1;

        if (stage === "review_a") {
          if (gateCalls[stage] === 1) {
            // First visit to A: Revise
            const revise = findOption(question.options, /revise/i);
            return { value: revise.key, selected_option: revise };
          }
          // Re-review at A: Approve
          const approve = findOption(question.options, /approve/i);
          return { value: approve.key, selected_option: approve };
        }
        // Gate B: always Approve
        const approve = findOption(question.options, /approve/i);
        return { value: approve.key, selected_option: approve };
      },
    };

    const logsRoot = await tempDir();
    const result = await runPipeline({ graph, logsRoot, backend, interviewer });

    expect(result.status).toBe("success");
    // Gate A should have been visited twice (initial Revise + re-review Approve)
    expect(gateCalls["review_a"]).toBe(2);
    // Gate B should only be visited once — the first attempt to reach it
    // (after revise) was intercepted by review_a's re-review redirect.
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
    const graph = parseDot(`
      digraph Test {
        graph [goal="Test"]
        start [shape=Mdiamond]
        exit [shape=Msquare]
        work [shape=box, prompt="Work"]
        start -> work -> exit
      }
    `);

    const controller = new AbortController();
    controller.abort(); // Pre-abort

    const events: PipelineEvent[] = [];
    const logsRoot = await tempDir();
    const result = await runPipeline({
      graph,
      logsRoot,
      backend: successBackend,
      abortSignal: controller.signal,
      onEvent: (e) => events.push(e),
    });

    expect(result.status).toBe("cancelled");
    expect(result.lastOutcome?.status).toBe("cancelled");
    // Should not have executed any non-start stages
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
          // Abort during this stage
          controller.abort();
        }
        return `Done: ${node.id}`;
      },
    };

    const graph = parseDot(`
      digraph Test {
        graph [goal="Test"]
        start [shape=Mdiamond]
        exit [shape=Msquare]
        work [shape=box, prompt="Work"]
        next [shape=box, prompt="Next"]
        start -> work -> next -> exit
      }
    `);

    const logsRoot = await tempDir();
    const result = await runPipeline({
      graph,
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
          // Schedule abort after a short delay (during backoff)
          setTimeout(() => controller.abort(), 10);
        }
        return { status: "fail", failure_reason: "test fail" } as Outcome;
      },
    };

    const graph = parseDot(`
      digraph Test {
        graph [goal="Test"]
        start [shape=Mdiamond]
        exit [shape=Msquare]
        work [shape=box, prompt="Work", max_retries=5]
        start -> work -> exit
      }
    `);

    const logsRoot = await tempDir();
    const startTime = Date.now();
    const result = await runPipeline({
      graph,
      logsRoot,
      backend: failingBackend,
      abortSignal: controller.signal,
    });
    const elapsed = Date.now() - startTime;

    expect(result.status).toBe("cancelled");
    // Should have exited quickly, not waited for all retries
    // With 5 retries and exponential backoff, full run would take >6s
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

    const graph = parseDot(`
      digraph Test {
        graph [goal="Test"]
        start [shape=Mdiamond]
        exit [shape=Msquare]
        work [shape=box, prompt="Work"]
        start -> work -> exit
      }
    `);

    const logsRoot = await tempDir();
    await runPipeline({
      graph,
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

    const graph = parseDot(`
      digraph Test {
        graph [goal="Test"]
        start [shape=Mdiamond]
        exit [shape=Msquare]
        work [shape=box, prompt="Work"]
        start -> work -> exit
      }
    `);

    const logsRoot = await tempDir();
    await runPipeline({
      graph,
      logsRoot,
      backend: abortBackend,
      abortSignal: controller.signal,
    });

    // Checkpoint should exist
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
          // Simulate workspace context being set
          context.set("workspace.path", "/tmp/fake-ws");
          context.set("workspace.name", "fake-ws");
          controller.abort();
        }
        return `Done: ${node.id}`;
      },
    };

    const graph = parseDot(`
      digraph Test {
        graph [goal="Test"]
        start [shape=Mdiamond]
        exit [shape=Msquare]
        work [shape=box, prompt="Work"]
        start -> work -> exit
      }
    `);

    const logsRoot = await tempDir();
    const result = await runPipeline({
      graph,
      logsRoot,
      backend: abortBackend,
      abortSignal: controller.signal,
      cleanupWorkspaceOnFailure: true,
      jjRunner: async () => { cleanupCalled = true; return ""; },
    });

    expect(result.status).toBe("cancelled");
    // Emergency cleanup should NOT have been called since this is cancellation, not failure
    expect(cleanupCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Usage tracking tests
// ---------------------------------------------------------------------------

describe("Pipeline Usage Tracking", () => {
  /** Backend that puts usage metrics into context_updates. */
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
    const graph = parseDot(`
      digraph G {
        graph [goal="Test usage"]
        start [shape=Mdiamond]
        exit [shape=Msquare]
        plan [shape=box, prompt="Plan"]
        impl [shape=box, prompt="Implement"]
        start -> plan -> impl -> exit
      }
    `);

    const logsRoot = await tempDir();
    const result = await runPipeline({
      graph,
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

    const graph = parseDot(`
      digraph G {
        graph [goal="Test retries"]
        start [shape=Mdiamond]
        exit [shape=Msquare]
        work [shape=box, prompt="Work", max_retries=2]
        start -> work -> exit
      }
    `);

    const logsRoot = await tempDir();
    const result = await runPipeline({ graph, logsRoot, backend: retryBackend });

    expect(result.status).toBe("success");
    expect(result.usageSummary).toBeDefined();
    // Both attempts should be in the breakdown
    expect(result.usageSummary!.stages.length).toBeGreaterThanOrEqual(1);
    // Totals should include cost from both attempts  
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

    const graph = parseDot(`
      digraph G {
        graph [goal="Test fail usage"]
        start [shape=Mdiamond]
        exit [shape=Msquare]
        work [shape=box, prompt="Work"]
        start -> work -> exit
      }
    `);

    const logsRoot = await tempDir();
    const result = await runPipeline({ graph, logsRoot, backend: failBackend });

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

    const graph = parseDot(`
      digraph G {
        graph [goal="Test cancel usage"]
        start [shape=Mdiamond]
        exit [shape=Msquare]
        a [shape=box, prompt="A"]
        b [shape=box, prompt="B"]
        start -> a -> b -> exit
      }
    `);

    const logsRoot = await tempDir();
    const result = await runPipeline({
      graph, logsRoot,
      backend: abortBackend,
      abortSignal: controller.signal,
    });

    expect(result.status).toBe("cancelled");
    expect(result.usageSummary).toBeDefined();
    expect(result.usageSummary!.totals.cost).toBe(0.01);
  });

  it("no usage: usageSummary has empty stages and zero totals", async () => {
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        exit [shape=Msquare]
        start -> exit
      }
    `);

    const logsRoot = await tempDir();
    const result = await runPipeline({ graph, logsRoot, backend: successBackend });

    expect(result.status).toBe("success");
    expect(result.usageSummary).toBeDefined();
    expect(result.usageSummary.stages).toHaveLength(0);
    expect(result.usageSummary.totals.cost).toBe(0);
    expect(result.usageSummary.totals.input_tokens).toBe(0);
  });

  it("emits usage_update events during execution", async () => {
    const graph = parseDot(`
      digraph G {
        graph [goal="Test events"]
        start [shape=Mdiamond]
        exit [shape=Msquare]
        work [shape=box, prompt="Work"]
        start -> work -> exit
      }
    `);

    const events: PipelineEvent[] = [];
    const logsRoot = await tempDir();
    await runPipeline({
      graph,
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

    const graph = parseDot(`
      digraph G {
        graph [goal="Test bad usage"]
        start [shape=Mdiamond]
        exit [shape=Msquare]
        work [shape=box, prompt="Work"]
        start -> work -> exit
      }
    `);

    const logsRoot = await tempDir();
    const result = await runPipeline({ graph, logsRoot, backend: badBackend });

    expect(result.status).toBe("success");
    expect(result.usageSummary).toBeDefined();
    // Non-numeric values should be treated as 0
    expect(result.usageSummary!.totals.input_tokens).toBe(0);
    expect(result.usageSummary!.totals.output_tokens).toBe(0);
    // NaN and Infinity should be treated as 0
    expect(result.usageSummary!.totals.cache_read_tokens).toBe(0);
    expect(result.usageSummary!.totals.cache_write_tokens).toBe(0);
    // Valid cost should still be captured
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

    const graph = parseDot(`
      digraph G {
        graph [goal="Test partial usage"]
        start [shape=Mdiamond]
        exit [shape=Msquare]
        work [shape=box, prompt="Work"]
        start -> work -> exit
      }
    `);

    const logsRoot = await tempDir();
    const result = await runPipeline({ graph, logsRoot, backend: costOnlyBackend });

    expect(result.status).toBe("success");
    expect(result.usageSummary).toBeDefined();
    expect(result.usageSummary!.totals.cost).toBe(0.05);
    expect(result.usageSummary!.totals.input_tokens).toBe(0);
  });
});
