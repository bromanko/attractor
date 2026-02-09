import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { runPipeline } from "./engine.js";
import { parseDot } from "./dot-parser.js";
import type { CodergenBackend, Outcome, PipelineEvent } from "./types.js";
import { Context } from "./types.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "attractor-test-"));
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
