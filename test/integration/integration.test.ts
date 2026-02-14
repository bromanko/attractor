/**
 * Integration tests for the Attractor pipeline engine.
 *
 * Each test loads a real workflow file, runs it through the engine
 * with a mock backend (no LLM calls), and asserts on behavior.
 */

import { describe, it, expect, afterAll } from "vitest";
import { readFile, mkdtemp, readdir, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseWorkflowDefinition, workflowToGraph } from "../../src/pipeline/workflow-loader.js";
import { parseWorkflowKdl } from "../../src/pipeline/workflow-kdl-parser.js";
import { validateWorkflow, validateWorkflowOrRaise } from "../../src/pipeline/workflow-validator.js";
import { runPipeline } from "../../src/pipeline/engine.js";
import { shouldParseStatusMarkers } from "../../src/pipeline/status-markers.js";
import type {
  CodergenBackend,
  Outcome,
  PipelineEvent,
  GraphNode,
  Checkpoint,
  Interviewer,
  Question,
  Answer,
} from "../../src/pipeline/types.js";
import { Context } from "../../src/pipeline/types.js";
import type { JjRunner } from "../../src/pipeline/workspace.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKFLOWS = join(import.meta.dirname, "workflows");

async function loadWorkflow(name: string) {
  const source = await readFile(join(WORKFLOWS, name), "utf-8");
  const workflow = parseWorkflowDefinition(source);
  return workflowToGraph(workflow);
}

async function loadWorkflowDefinition(name: string) {
  const source = await readFile(join(WORKFLOWS, name), "utf-8");
  return parseWorkflowKdl(source);
}

let suiteTempRootPromise: Promise<string> | undefined;
let tempDirCounter = 0;

async function getSuiteTempRoot(): Promise<string> {
  if (!suiteTempRootPromise) {
    suiteTempRootPromise = mkdtemp(join(tmpdir(), "attractor-integ-"));
  }
  return suiteTempRootPromise;
}

async function tempDir() {
  const suiteRoot = await getSuiteTempRoot();
  const dir = join(suiteRoot, `test-${tempDirCounter++}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

afterAll(async () => {
  if (!suiteTempRootPromise) return;
  const suiteRoot = await suiteTempRootPromise;
  await rm(suiteRoot, { recursive: true, force: true });
});

/** Backend that always succeeds with a simple response. */
const successBackend: CodergenBackend = {
  async run(node) {
    return `Completed: ${node.id}`;
  },
};

/** Backend that returns a specific outcome for specific nodes. */
function nodeOutcomeBackend(
  outcomes: Record<string, Outcome>,
): CodergenBackend {
  return {
    async run(node) {
      if (node.id in outcomes) return outcomes[node.id];
      return `Completed: ${node.id}`;
    },
  };
}

/** Backend that captures the prompt sent to each node. */
function promptCapture(): {
  backend: CodergenBackend;
  prompts: Map<string, string>;
} {
  const prompts = new Map<string, string>();
  return {
    prompts,
    backend: {
      async run(node, prompt) {
        prompts.set(node.id, prompt);
        return `Completed: ${node.id}`;
      },
    },
  };
}

/** Backend that records which nodes were executed, in order. */
function trackingBackend(): {
  executedNodes: string[];
  backend: CodergenBackend;
} {
  const executedNodes: string[] = [];
  return {
    executedNodes,
    backend: {
      async run(node) {
        executedNodes.push(node.id);
        return `Done: ${node.id}`;
      },
    },
  };
}

/** Collect pipeline events. */
function eventCollector(): {
  events: PipelineEvent[];
  onEvent: (e: PipelineEvent) => void;
} {
  const events: PipelineEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

/** Interviewer that always picks the first option (approve). */
const approveInterviewer: Interviewer = {
  async ask(question: Question): Promise<Answer> {
    if (question.options.length > 0) {
      return { value: question.options[0].key, selected_option: question.options[0] };
    }
    return { value: "yes" };
  },
};

/** Interviewer that always picks a specific option by label substring. */
function selectInterviewer(labelSubstring: string): Interviewer {
  return {
    async ask(question: Question): Promise<Answer> {
      const match = question.options.find((o) =>
        o.label.toLowerCase().includes(labelSubstring.toLowerCase()),
      );
      if (match) return { value: match.key, selected_option: match };
      return { value: question.options[0]?.key ?? "yes", selected_option: question.options[0] };
    },
  };
}

/** Mock jj runner for workspace tests. */
function mockJj(
  overrides: Record<string, string> = {},
): JjRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const runner = async (args: string[]): Promise<string> => {
    calls.push([...args]);
    const cmd = args.slice(0, 2).join(" ");
    if (cmd in overrides) return overrides[cmd];
    if (args[0] in overrides) return overrides[args[0]];
    return "";
  };
  (runner as any).calls = calls;
  return runner as JjRunner & { calls: string[][] };
}

/**
 * Build a mock CodergenBackend that returns text responses per node and
 * parses status markers the same way the real backend does.
 */
function statusAwareBackend(
  responses: Record<string, string>,
  fallback = "Done.",
): CodergenBackend {
  return {
    async run(node: GraphNode): Promise<Outcome | string> {
      const text = responses[node.id] ?? fallback;

      if (!shouldParseStatusMarkers(node)) {
        return text;
      }

      // Parse status markers for auto_status nodes
      const outcome: Outcome = {
        status: "success",
        notes: text.slice(0, 500),
        context_updates: { [`${node.id}.response`]: text.slice(0, 2000) },
      };

      const statusMatch = text.match(/\[STATUS:\s*(success|fail|partial_success|retry)\]/i);
      if (statusMatch) {
        outcome.status = statusMatch[1].toLowerCase() as Outcome["status"];
      }

      const failMatch = text.match(/\[FAILURE_REASON:\s*(.+?)\]/i);
      if (failMatch) {
        outcome.failure_reason = failMatch[1].trim();
      } else if (outcome.status === "fail") {
        outcome.failure_reason = text.slice(0, 200);
      }

      return outcome;
    },
  };
}

// ===========================================================================
// 1. Linear pipeline
// ===========================================================================

describe("Linear pipeline", () => {
  it("traverses start → work → exit", async () => {
    const graph = await loadWorkflow("linear.awf.kdl");
    const logs = await tempDir();
    const result = await runPipeline({ graph, logsRoot: logs, backend: successBackend });

    expect(result.status).toBe("success");
    expect(result.completedNodes).toEqual(["__start__", "work", "exit"]);
  });

  it("writes prompt and response artifacts", async () => {
    const graph = await loadWorkflow("linear.awf.kdl");
    const logs = await tempDir();
    await runPipeline({ graph, logsRoot: logs, backend: successBackend });

    const prompt = await readFile(join(logs, "work", "prompt.md"), "utf-8");
    expect(prompt).toContain("Test linear execution");

    const response = await readFile(join(logs, "work", "response.md"), "utf-8");
    expect(response).toContain("Completed: work");

    const status = JSON.parse(await readFile(join(logs, "work", "status.json"), "utf-8"));
    expect(status.outcome).toBe("success");
  });

  it("writes checkpoint.json after each node", async () => {
    const graph = await loadWorkflow("linear.awf.kdl");
    const logs = await tempDir();
    await runPipeline({ graph, logsRoot: logs, backend: successBackend });

    const cp = JSON.parse(await readFile(join(logs, "checkpoint.json"), "utf-8"));
    expect(cp.completed_nodes).toContain("work");
    // The last checkpoint is saved after the penultimate node (exit node
    // is executed but pipeline ends immediately after, so exit may not
    // appear in the checkpoint's completed_nodes).
    expect(cp.context_values["graph.goal"]).toBe("Test linear execution");
  });
});

// ===========================================================================
// 2. Conditional branching
// ===========================================================================

describe("Conditional branching", () => {
  it("takes success path when build succeeds", async () => {
    const graph = await loadWorkflow("branching.awf.kdl");
    const logs = await tempDir();
    const result = await runPipeline({ graph, logsRoot: logs, backend: successBackend });

    expect(result.status).toBe("success");
    expect(result.completedNodes).toContain("deploy");
    expect(result.completedNodes).not.toContain("fix");
  });

  it("takes failure path when build fails", async () => {
    const backend = nodeOutcomeBackend({
      build: { status: "fail", failure_reason: "compile error" },
    });
    const graph = await loadWorkflow("branching.awf.kdl");
    const logs = await tempDir();
    const result = await runPipeline({ graph, logsRoot: logs, backend });

    expect(result.status).toBe("success");
    expect(result.completedNodes).toContain("fix");
    expect(result.completedNodes).not.toContain("deploy");
  });
});

// ===========================================================================
// 3. Retry logic and fix loop
// ===========================================================================

describe("Retry and fix loop", () => {
  it("completes when all stages succeed", async () => {
    const graph = await loadWorkflow("retry-loop.awf.kdl");
    const logs = await tempDir();
    const result = await runPipeline({ graph, logsRoot: logs, backend: successBackend });

    expect(result.status).toBe("success");
    expect(result.completedNodes).toContain("implement");
    expect(result.completedNodes).toContain("ci");
  });

  it("retries a node up to max_retries on failure", async () => {
    let attempts = 0;
    const backend: CodergenBackend = {
      async run(node) {
        if (node.id === "implement") {
          attempts++;
          if (attempts <= 2) return { status: "fail", failure_reason: `attempt ${attempts}` };
        }
        return `Done: ${node.id}`;
      },
    };

    const graph = await loadWorkflow("retry-loop.awf.kdl");
    const logs = await tempDir();
    const result = await runPipeline({ graph, logsRoot: logs, backend });

    // 2 retries + 1 final = 3 attempts, third one succeeds
    expect(attempts).toBe(3);
    expect(result.status).toBe("success");
  });
});

// ===========================================================================
// 4. Human gate
// ===========================================================================

describe("Human gate", () => {
  it("follows approve path with approve interviewer", async () => {
    const graph = await loadWorkflow("human-gate.awf.kdl");
    const logs = await tempDir();
    const result = await runPipeline({
      graph,
      logsRoot: logs,
      backend: successBackend,
      interviewer: approveInterviewer,
    });

    expect(result.status).toBe("success");
    expect(result.completedNodes).toContain("implement");
  });

  it("follows revise path when human selects Revise", async () => {
    // First call: select Revise; second call: select Approve
    let callCount = 0;
    const interviewer: Interviewer = {
      async ask(q: Question): Promise<Answer> {
        callCount++;
        if (callCount === 1) {
          const revise = q.options.find((o) => o.label.includes("Revise"));
          return { value: revise!.key, selected_option: revise };
        }
        const approve = q.options.find((o) => o.label.includes("Approve"));
        return { value: approve!.key, selected_option: approve };
      },
    };

    const graph = await loadWorkflow("human-gate.awf.kdl");
    const logs = await tempDir();
    const result = await runPipeline({
      graph,
      logsRoot: logs,
      backend: successBackend,
      interviewer,
    });

    expect(result.status).toBe("success");
    expect(result.completedNodes).toContain("revise");
    expect(result.completedNodes).toContain("implement");
  });
});

// ===========================================================================
// 5. Tool node
// ===========================================================================

describe("Tool node", () => {
  it("executes shell command and captures output", async () => {
    const graph = await loadWorkflow("tool-node.awf.kdl");
    const logs = await tempDir();
    const { events, onEvent } = eventCollector();
    const result = await runPipeline({
      graph,
      logsRoot: logs,
      backend: successBackend,
      onEvent,
    });

    expect(result.status).toBe("success");
    expect(result.completedNodes).toContain("check");
    expect(result.completedNodes).toContain("report");
  });

  it("tool failure routes through gate to exit", async () => {
    // Modify the graph to use a command that fails
    const graph = await loadWorkflow("tool-node.awf.kdl");
    const checkNode = graph.nodes.find((n) => n.id === "check")!;
    checkNode.attrs.tool_command = "false";  // exit code 1

    const logs = await tempDir();
    const result = await runPipeline({
      graph,
      logsRoot: logs,
      backend: successBackend,
    });

    // Tool fails → gate → outcome!=success → exit
    expect(result.status).toBe("success");
    expect(result.completedNodes).toContain("check");
    expect(result.completedNodes).not.toContain("report");
  });
});

// ===========================================================================
// 6. Goal gate
// ===========================================================================

describe("Goal gate", () => {
  it("passes when goal-gated node succeeds", async () => {
    const graph = await loadWorkflow("goal-gate.awf.kdl");
    const logs = await tempDir();
    const result = await runPipeline({ graph, logsRoot: logs, backend: successBackend });

    expect(result.status).toBe("success");
  });

  it("fails pipeline when goal-gated node fails", async () => {
    const backend = nodeOutcomeBackend({
      critical: { status: "fail", failure_reason: "critical task failed" },
    });
    const graph = await loadWorkflow("goal-gate.awf.kdl");
    const logs = await tempDir();
    const result = await runPipeline({ graph, logsRoot: logs, backend });

    expect(result.status).toBe("fail");
  });
});

// ===========================================================================
// 7. Multi-review chain
// ===========================================================================

describe("Multi-review chain", () => {
  it("passes all reviews → exits successfully", async () => {
    const graph = await loadWorkflow("multi-review.awf.kdl");
    const logs = await tempDir();
    const result = await runPipeline({ graph, logsRoot: logs, backend: successBackend });

    expect(result.status).toBe("success");
    expect(result.completedNodes).toContain("rev1");
    expect(result.completedNodes).toContain("rev2");
    expect(result.completedNodes).toContain("rev3");
    expect(result.completedNodes).not.toContain("fix");
  });

  it("short-circuits to gate when first review fails", async () => {
    // rev1 fails on first pass, succeeds after fix
    let rev1Calls = 0;
    const backend: CodergenBackend = {
      async run(node) {
        if (node.id === "rev1") {
          rev1Calls++;
          if (rev1Calls === 1) return { status: "fail", failure_reason: "code quality issues" };
        }
        return `Done: ${node.id}`;
      },
    };
    const graph = await loadWorkflow("multi-review.awf.kdl");
    const logs = await tempDir();
    const result = await runPipeline({ graph, logsRoot: logs, backend });

    expect(result.completedNodes).toContain("rev1");
    expect(result.completedNodes).toContain("gate");
    expect(result.completedNodes).toContain("fix");
    expect(result.status).toBe("success");
  });

  it("short-circuits at second review failure", async () => {
    // rev2 fails on first pass, succeeds after fix
    let rev2Calls = 0;
    const backend: CodergenBackend = {
      async run(node) {
        if (node.id === "rev2") {
          rev2Calls++;
          if (rev2Calls === 1) return { status: "fail", failure_reason: "security vulnerability" };
        }
        return `Done: ${node.id}`;
      },
    };
    const graph = await loadWorkflow("multi-review.awf.kdl");
    const logs = await tempDir();
    const result = await runPipeline({ graph, logsRoot: logs, backend });

    expect(result.completedNodes).toContain("rev1");
    expect(result.completedNodes).toContain("rev2");
    expect(result.completedNodes).toContain("gate");
    expect(result.completedNodes).toContain("fix");
    expect(result.status).toBe("success");
  });
});

// ===========================================================================
// 8. Variable expansion
// ===========================================================================

describe("Variable expansion", () => {
  it("expands $goal in prompts", async () => {
    const { backend, prompts } = promptCapture();
    const graph = await loadWorkflow("variable-expansion.awf.kdl");
    const logs = await tempDir();
    await runPipeline({ graph, logsRoot: logs, backend });

    expect(prompts.get("plan")).toBe("Plan: Build a REST API");
    expect(prompts.get("impl")).toBe("Implement: Build a REST API");
  });

  it("expands --goal override", async () => {
    const { backend, prompts } = promptCapture();
    const graph = await loadWorkflow("variable-expansion.awf.kdl");
    graph.attrs.goal = "Custom goal override";
    const logs = await tempDir();
    await runPipeline({ graph, logsRoot: logs, backend });

    expect(prompts.get("plan")).toBe("Plan: Custom goal override");
  });
});

// ===========================================================================
// 9. Edge weight selection
// ===========================================================================

describe("Edge weight selection", () => {
  it("follows higher-weighted unconditional edge", async () => {
    const graph = await loadWorkflow("weighted-edges.awf.kdl");
    const logs = await tempDir();
    const result = await runPipeline({ graph, logsRoot: logs, backend: successBackend });

    expect(result.completedNodes).toContain("path_hi");
    expect(result.completedNodes).not.toContain("path_lo");
  });
});

// ===========================================================================
// 10. Checkpoint and resume
// ===========================================================================

describe("Checkpoint and resume", () => {
  it("resumes from a saved checkpoint", async () => {
    const graph = await loadWorkflow("checkpoint-resume.awf.kdl");

    // First run: complete all
    const logs1 = await tempDir();
    await runPipeline({ graph, logsRoot: logs1, backend: successBackend });

    const cp: Checkpoint = JSON.parse(
      await readFile(join(logs1, "checkpoint.json"), "utf-8"),
    );

    // Modify checkpoint to resume from node "c"
    cp.resume_at = "c";

    const logs2 = await tempDir();
    const result = await runPipeline({
      graph,
      logsRoot: logs2,
      backend: successBackend,
      checkpoint: cp,
    });

    expect(result.status).toBe("success");
    // Should have re-executed c and d, not a and b
    expect(result.completedNodes).toContain("c");
    expect(result.completedNodes).toContain("d");
  });

  it("restores context from checkpoint", async () => {
    const graph = await loadWorkflow("checkpoint-resume.awf.kdl");
    const logs1 = await tempDir();
    await runPipeline({ graph, logsRoot: logs1, backend: successBackend });

    const cp: Checkpoint = JSON.parse(
      await readFile(join(logs1, "checkpoint.json"), "utf-8"),
    );
    cp.resume_at = "d";

    let capturedGoal: unknown;
    const captureBackend: CodergenBackend = {
      async run(node, _prompt, ctx) {
        if (node.id === "d") capturedGoal = ctx.get("graph.goal");
        return `Done: ${node.id}`;
      },
    };

    const logs2 = await tempDir();
    await runPipeline({
      graph,
      logsRoot: logs2,
      backend: captureBackend,
      checkpoint: cp,
    });

    expect(capturedGoal).toBe("Test checkpoint and resume");
  });

  it("cancellation after edge selection saves next_node in checkpoint and resumes correctly", async () => {
    const graph = await loadWorkflow("checkpoint-resume.awf.kdl");
    const logs = await tempDir();
    const ac = new AbortController();

    // Abort when the checkpoint_saved event fires for node "b".
    // At that point the engine has already completed edge selection and
    // written the checkpoint with next_node populated. The subsequent
    // checkCancelled call (with nextNodeId) detects the abort and saves
    // the cancellation checkpoint — also with next_node.
    const onEvent = (e: PipelineEvent) => {
      if (e.kind === "checkpoint_saved" && e.data.node_id === "b") {
        ac.abort();
      }
    };

    const result = await runPipeline({
      graph,
      logsRoot: logs,
      backend: successBackend,
      abortSignal: ac.signal,
      onEvent,
    });

    expect(result.status).toBe("cancelled");

    // Verify the checkpoint file contains both current_node and next_node
    const cp: Checkpoint = JSON.parse(
      await readFile(join(logs, "checkpoint.json"), "utf-8"),
    );
    expect(cp.current_node).toBe("b");
    expect(cp.next_node).toBe("c");
    expect(cp.completed_nodes).toContain("a");
    expect(cp.completed_nodes).toContain("b");

    // Resume from the cancellation checkpoint — should start at next_node ("c"),
    // NOT re-execute "b"
    const logs2 = await tempDir();
    const { executedNodes, backend: resumeBackend } = trackingBackend();

    const resumed = await runPipeline({
      graph,
      logsRoot: logs2,
      backend: resumeBackend,
      checkpoint: cp,
    });

    expect(resumed.status).toBe("success");
    // Only "c" and "d" should be executed, in order
    expect(executedNodes).toEqual(["c", "d"]);
  });

  it("cancellation before edge selection saves checkpoint without next_node", async () => {
    const graph = await loadWorkflow("checkpoint-resume.awf.kdl");
    const logs = await tempDir();
    const ac = new AbortController();
    let nodeCount = 0;

    // Abort during node "b"'s execution. The abort signal is detected
    // at the post-execution cancellation check, which fires before edge
    // selection — so checkCancelled is called without nextNodeId.
    const backend: CodergenBackend = {
      async run(node) {
        nodeCount++;
        if (nodeCount === 2) ac.abort(); // abort during "b"
        return `Done: ${node.id}`;
      },
    };

    const result = await runPipeline({
      graph,
      logsRoot: logs,
      backend,
      abortSignal: ac.signal,
    });

    expect(result.status).toBe("cancelled");

    // Verify the checkpoint does NOT contain next_node — cancellation
    // occurred before edge selection could resolve the next target.
    const cp: Checkpoint = JSON.parse(
      await readFile(join(logs, "checkpoint.json"), "utf-8"),
    );
    expect(cp.current_node).toBe("b");
    expect(cp.next_node).toBeUndefined();
    expect(cp.completed_nodes).toContain("a");
    // "b" is NOT in completed_nodes because the cancellation check fires
    // before completedNodes.push(node.id) in the engine loop.
    expect(cp.completed_nodes).not.toContain("b");

    // Resume from a checkpoint without next_node — the engine should
    // fall back to re-executing current_node ("b").
    const logs2 = await tempDir();
    const { executedNodes, backend: resumeBackend } = trackingBackend();

    const resumed = await runPipeline({
      graph,
      logsRoot: logs2,
      backend: resumeBackend,
      checkpoint: cp,
    });

    expect(resumed.status).toBe("success");
    // "b" should be re-executed as the first node (fallback to current_node)
    expect(executedNodes).toEqual(["b", "c", "d"]);
  });
});

// ===========================================================================
// 11. Failure halts pipeline
// ===========================================================================

describe("Failure halts pipeline", () => {
  it("stops when node fails with no failure edge", async () => {
    const backend = nodeOutcomeBackend({
      setup: { status: "fail", failure_reason: "setup exploded" },
    });
    const graph = await loadWorkflow("fail-halts.awf.kdl");
    const logs = await tempDir();
    const { events, onEvent } = eventCollector();
    const result = await runPipeline({
      graph,
      logsRoot: logs,
      backend,
      onEvent,
    });

    expect(result.status).toBe("fail");
    expect(result.completedNodes).toContain("setup");
    expect(result.completedNodes).not.toContain("work");
    expect(result.completedNodes).not.toContain("finish");
    expect(events.some((e) => e.kind === "pipeline_failed")).toBe(true);
  });
});

// ===========================================================================
// 12. Failure forwarded through gate
// ===========================================================================

describe("Failure forwarded through gate", () => {
  it("routes failure through unconditional edge to conditional gate", async () => {
    const backend = nodeOutcomeBackend({
      review: { status: "fail", failure_reason: "needs work" },
    });
    const graph = await loadWorkflow("fail-to-gate.awf.kdl");
    const logs = await tempDir();
    const result = await runPipeline({ graph, logsRoot: logs, backend });

    expect(result.status).toBe("success");
    expect(result.completedNodes).toContain("review");
    expect(result.completedNodes).toContain("gate");
    expect(result.completedNodes).toContain("revise");
    expect(result.completedNodes).not.toContain("ok");
  });
});

// ===========================================================================
// 13. Large pipeline
// ===========================================================================

describe("Large pipeline", () => {
  it("traverses 15+ node pipeline end-to-end", async () => {
    const graph = await loadWorkflow("large-pipeline.awf.kdl");
    const logs = await tempDir();
    const result = await runPipeline({ graph, logsRoot: logs, backend: successBackend });

    expect(result.status).toBe("success");
    expect(result.completedNodes.length).toBeGreaterThanOrEqual(12);
    expect(result.completedNodes).toContain("deploy");
    expect(result.completedNodes).toContain("exit");
  });

  it("validates without errors", async () => {
    const workflow = await loadWorkflowDefinition("large-pipeline.awf.kdl");
    const diagnostics = validateWorkflow(workflow);
    const errors = diagnostics.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);
  });
});

// ===========================================================================
// 14. Workspace lifecycle (mock jj)
// ===========================================================================

describe("Workspace lifecycle", () => {
  it("create → work → merge → cleanup with mock jj", async () => {
    const jj = mockJj({
      root: "/tmp/test-repo",
      "workspace list": "default: /tmp/test-repo",
      log: "abc12345",
      "workspace add": "",
      rebase: "",
      "workspace forget": "",
    });

    const graph = await loadWorkflow("workspace-lifecycle.awf.kdl");
    const logs = await tempDir();
    const result = await runPipeline({
      graph,
      logsRoot: logs,
      backend: successBackend,
      jjRunner: jj,
      cleanupWorkspaceOnFailure: false,
    });

    expect(result.status).toBe("success");
    expect(result.completedNodes).toContain("ws_create");
    expect(result.completedNodes).toContain("work");
    expect(result.completedNodes).toContain("ws_merge");
    expect(result.completedNodes).toContain("ws_cleanup");

    // Verify jj calls
    expect(jj.calls.some((c) => c[0] === "workspace" && c[1] === "add")).toBe(true);
    expect(jj.calls.some((c) => c[0] === "workspace" && c[1] === "forget")).toBe(true);
  });
});

// ===========================================================================
// 15. Validation — invalid workflows
// ===========================================================================

describe("Validation", () => {
  it("rejects workflow with missing start target", async () => {
    const wf = await loadWorkflowDefinition("invalid-no-start.awf.kdl");
    const diagnostics = validateWorkflow(wf);
    const errors = diagnostics.filter((d) => d.severity === "error");

    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((d) => d.rule === "workflow_start_exists")).toBe(true);
  });

  it("rejects workflow with no exit node", async () => {
    const wf = await loadWorkflowDefinition("invalid-no-exit.awf.kdl");
    const diagnostics = validateWorkflow(wf);
    const errors = diagnostics.filter((d) => d.severity === "error");

    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((d) => d.rule === "workflow_reachable_exit")).toBe(true);
  });

  it("flags unreachable stages", async () => {
    const wf = await loadWorkflowDefinition("invalid-unreachable.awf.kdl");
    const diagnostics = validateWorkflow(wf);

    expect(diagnostics.some((d) => d.rule === "workflow_reachability")).toBe(true);
  });

  it("throws on validateWorkflowOrRaise for invalid workflows", async () => {
    const wf = await loadWorkflowDefinition("invalid-no-start.awf.kdl");
    expect(() => validateWorkflowOrRaise(wf)).toThrow(/Workflow validation failed/i);
  });

  it("validates all valid workflow files without errors", async () => {
    const validFiles = [
      "linear.awf.kdl",
      "branching.awf.kdl",
      "retry-loop.awf.kdl",
      "human-gate.awf.kdl",
      "tool-node.awf.kdl",
      "goal-gate.awf.kdl",
      "multi-review.awf.kdl",
      "variable-expansion.awf.kdl",
      "weighted-edges.awf.kdl",
      "checkpoint-resume.awf.kdl",
      "fail-halts.awf.kdl",
      "fail-to-gate.awf.kdl",
      "large-pipeline.awf.kdl",
      "workspace-lifecycle.awf.kdl",
      "auto-status.awf.kdl",
    ];

    const workflows = await Promise.all(
      validFiles.map(async (file) => ({
        file,
        wf: await loadWorkflowDefinition(file),
      })),
    );

    for (const { file, wf } of workflows) {
      const diagnostics = validateWorkflow(wf);
      const errors = diagnostics.filter((d) => d.severity === "error");
      expect(errors, `${file} should have no validation errors`).toHaveLength(0);
    }
  });
});

// ===========================================================================
// 17. Event emission
// ===========================================================================

describe("Event emission", () => {
  it("emits lifecycle events in correct order", async () => {
    const graph = await loadWorkflow("linear.awf.kdl");
    const logs = await tempDir();
    const { events, onEvent } = eventCollector();
    await runPipeline({ graph, logsRoot: logs, backend: successBackend, onEvent });

    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe("pipeline_started");
    expect(kinds[kinds.length - 1]).toBe("pipeline_completed");
    expect(kinds.filter((k) => k === "stage_started").length).toBeGreaterThanOrEqual(2);
    expect(kinds.filter((k) => k === "stage_completed").length).toBeGreaterThanOrEqual(2);
    expect(kinds.filter((k) => k === "checkpoint_saved").length).toBeGreaterThanOrEqual(1);
  });

  it("emits pipeline_failed on halt", async () => {
    const backend = nodeOutcomeBackend({
      setup: { status: "fail", failure_reason: "boom" },
    });
    const graph = await loadWorkflow("fail-halts.awf.kdl");
    const logs = await tempDir();
    const { events, onEvent } = eventCollector();
    await runPipeline({ graph, logsRoot: logs, backend, onEvent });

    expect(events.some((e) => e.kind === "pipeline_failed")).toBe(true);
    expect(events.some((e) => e.kind === "stage_failed")).toBe(true);
  });

  it("emits pipeline_resumed when resuming from checkpoint", async () => {
    const graph = await loadWorkflow("checkpoint-resume.awf.kdl");
    const logs1 = await tempDir();
    await runPipeline({ graph, logsRoot: logs1, backend: successBackend });

    const cp: Checkpoint = JSON.parse(
      await readFile(join(logs1, "checkpoint.json"), "utf-8"),
    );
    cp.resume_at = "c";

    const logs2 = await tempDir();
    const { events, onEvent } = eventCollector();
    await runPipeline({
      graph,
      logsRoot: logs2,
      backend: successBackend,
      checkpoint: cp,
      onEvent,
    });

    expect(events.some((e) => e.kind === "pipeline_resumed")).toBe(true);
  });

  it("checkpoint includes next_node after edge selection", async () => {
    const graph = await loadWorkflow("checkpoint-resume.awf.kdl");
    const logs = await tempDir();
    await runPipeline({ graph, logsRoot: logs, backend: successBackend });

    const cp: Checkpoint = JSON.parse(
      await readFile(join(logs, "checkpoint.json"), "utf-8"),
    );

    // The last checkpoint is saved after the last non-exit node ("d")
    // completes, with next_node pointing to "exit".
    expect(cp.current_node).toBe("d");
    expect(cp.next_node).toBe("exit");
  });

  it("resumes at next_node without re-executing current_node", async () => {
    const graph = await loadWorkflow("checkpoint-resume.awf.kdl");

    // First run: complete all nodes
    const logs1 = await tempDir();
    await runPipeline({ graph, logsRoot: logs1, backend: successBackend });

    const cp: Checkpoint = JSON.parse(
      await readFile(join(logs1, "checkpoint.json"), "utf-8"),
    );

    // Simulate resuming from a checkpoint saved after "b" completed.
    // Set current_node to "b" and next_node to "c" — "b" should NOT be
    // re-executed; execution should start at "c".
    cp.current_node = "b";
    cp.next_node = "c";
    cp.completed_nodes = ["a", "b"];

    const { executedNodes, backend: resumeBackend } = trackingBackend();

    const logs2 = await tempDir();
    const result = await runPipeline({
      graph,
      logsRoot: logs2,
      backend: resumeBackend,
      checkpoint: cp,
    });

    expect(result.status).toBe("success");
    // Only c and d should be executed, in order
    expect(executedNodes).toEqual(["c", "d"]);
    // completed_nodes should include all four plus exit
    expect(result.completedNodes).toContain("a");
    expect(result.completedNodes).toContain("b");
    expect(result.completedNodes).toContain("c");
    expect(result.completedNodes).toContain("d");
  });

  it("falls back to re-executing current_node when next_node is absent", async () => {
    const graph = await loadWorkflow("checkpoint-resume.awf.kdl");

    // Simulate an old-style checkpoint without next_node
    const cp: Checkpoint = {
      timestamp: new Date().toISOString(),
      current_node: "c",
      completed_nodes: ["a", "b", "c"],
      node_retries: {},
      context_values: { "graph.goal": "Test checkpoint and resume" },
      logs: [],
    };

    const { executedNodes, backend: resumeBackend } = trackingBackend();

    const logs = await tempDir();
    const result = await runPipeline({
      graph,
      logsRoot: logs,
      backend: resumeBackend,
      checkpoint: cp,
    });

    expect(result.status).toBe("success");
    // Without next_node, current_node ("c") should be re-executed as the
    // *first* node — verifying fallback actually restarts at current_node.
    expect(executedNodes).toEqual(["c", "d"]);
  });

  it("resume_at takes precedence over next_node", async () => {
    const graph = await loadWorkflow("checkpoint-resume.awf.kdl");

    // Checkpoint with all three fields set: resume_at should win over
    // next_node and current_node per the engine's fallback chain
    // (resume_at ?? next_node ?? current_node).
    const cp: Checkpoint = {
      timestamp: new Date().toISOString(),
      current_node: "a",
      next_node: "d",
      resume_at: "b",
      completed_nodes: ["a"],
      node_retries: {},
      context_values: { "graph.goal": "Test checkpoint and resume" },
      logs: [],
    };

    const { executedNodes, backend: resumeBackend } = trackingBackend();

    const logs = await tempDir();
    const result = await runPipeline({
      graph,
      logsRoot: logs,
      backend: resumeBackend,
      checkpoint: cp,
    });

    expect(result.status).toBe("success");
    // resume_at = "b" should win: b, c, d executed; a skipped
    // resume_at = "b" should win: b, c, d executed in order; a skipped
    expect(executedNodes).toEqual(["b", "c", "d"]);
  });

  it("fails with clear error when next_node references a removed graph node", async () => {
    const graph = await loadWorkflow("checkpoint-resume.awf.kdl");

    // Simulate a checkpoint saved before a graph modification removed the target node
    const cp: Checkpoint = {
      timestamp: new Date().toISOString(),
      current_node: "b",
      next_node: "removed_node",
      completed_nodes: ["a", "b"],
      node_retries: {},
      context_values: { "graph.goal": "Test checkpoint and resume" },
      logs: [],
    };

    const logs = await tempDir();
    const { events, onEvent } = eventCollector();
    const result = await runPipeline({
      graph,
      logsRoot: logs,
      backend: successBackend,
      checkpoint: cp,
      onEvent,
    });

    expect(result.status).toBe("fail");
    expect(result.lastOutcome?.failure_reason).toContain("removed_node");
    expect(result.lastOutcome?.failure_reason).toContain("next_node");
    expect(result.lastOutcome?.failure_reason).toContain("does not exist");

    const failEvent = events.find((e) => e.kind === "pipeline_failed");
    expect(failEvent).toBeDefined();
    expect(failEvent!.data.error).toContain("removed_node");
  });

  it("fails with clear error when resume_at references a removed graph node", async () => {
    const graph = await loadWorkflow("checkpoint-resume.awf.kdl");

    const cp: Checkpoint = {
      timestamp: new Date().toISOString(),
      current_node: "a",
      next_node: "c",
      resume_at: "nonexistent",
      completed_nodes: ["a"],
      node_retries: {},
      context_values: { "graph.goal": "Test checkpoint and resume" },
      logs: [],
    };

    const logs = await tempDir();
    const result = await runPipeline({
      graph,
      logsRoot: logs,
      backend: successBackend,
      checkpoint: cp,
    });

    expect(result.status).toBe("fail");
    expect(result.lastOutcome?.failure_reason).toContain("nonexistent");
    expect(result.lastOutcome?.failure_reason).toContain("resume_at");
  });
});

// ===========================================================================
// 18. Context flow between nodes
// ===========================================================================

describe("Context flow", () => {
  it("passes context from earlier nodes to later ones", async () => {
    let bContext: Record<string, unknown> | undefined;
    const backend: CodergenBackend = {
      async run(node, _prompt, ctx) {
        if (node.id === "b") {
          bContext = ctx.snapshot();
        }
        return `Done: ${node.id}`;
      },
    };

    const graph = await loadWorkflow("checkpoint-resume.awf.kdl");
    const logs = await tempDir();
    await runPipeline({ graph, logsRoot: logs, backend });

    expect(bContext).toBeDefined();
    expect(bContext!["last_stage"]).toBe("a");
    expect(bContext!["outcome"]).toBe("success");
  });
});

// ===========================================================================
// 19. CLI validate command (subprocess)
// ===========================================================================

describe("CLI", () => {
  // Use the TypeScript source via tsx rather than the Nix wrapper
  const CLI = join(import.meta.dirname, "../../dist/cli.js");
  const CWD = join(import.meta.dirname, "../..");

  it("validate accepts valid workflow", async () => {
    const result = execFileSync(
      "node",
      ["--experimental-vm-modules", CLI, "validate", join(WORKFLOWS, "linear.awf.kdl")],
      { encoding: "utf-8", cwd: CWD },
    );
    expect(result).toContain("valid");
  });

  it("validate rejects invalid workflow", async () => {
    try {
      execFileSync(
        "node",
        ["--experimental-vm-modules", CLI, "validate", join(WORKFLOWS, "invalid-no-start.awf.kdl")],
        { encoding: "utf-8", cwd: CWD },
      );
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.status).toBe(1);
    }
  });

  it("--dry-run prints graph info without executing", async () => {
    const result = execFileSync(
      "node",
      [
        "--experimental-vm-modules", CLI,
        "run", join(WORKFLOWS, "linear.awf.kdl"),
        "--dry-run",
      ],
      { encoding: "utf-8", cwd: CWD },
    );
    expect(result).toContain("Nodes:");
    expect(result).toContain("Edges:");
    expect(result).toContain("start");
    expect(result).toContain("work");
    expect(result).toContain("exit");
  });
});

// ===========================================================================
// 20. auto_status → status marker parsing (end-to-end)
// ===========================================================================

describe("auto_status parsing end-to-end", () => {
  it("parses [STATUS: fail] for auto_status=true node loaded from workflow", async () => {
    const graph = await loadWorkflow("auto-status.awf.kdl");
    const logs = await tempDir();

    // Verify the workflow parser produced the correct auto_status type
    const reviewNode = graph.nodes.find((n) => n.id === "review")!;
    expect(reviewNode.attrs.auto_status).toBe(true);

    const backend = statusAwareBackend({
      review: "Looks bad.\n[STATUS: fail]\n[FAILURE_REASON: Missing error handling]",
    });

    const result = await runPipeline({ graph, logsRoot: logs, backend });

    // review has auto_status=true → [STATUS: fail] is honoured → pipeline halts
    // (no failure edge from review)
    expect(result.status).toBe("fail");
    expect(result.completedNodes).toContain("review");
    expect(result.completedNodes).not.toContain("exit");
    expect(result.lastOutcome?.status).toBe("fail");
    expect(result.lastOutcome?.failure_reason).toBe("Missing error handling");
  });

  it("ignores [STATUS: fail] for codergen node (no auto_status) loaded from workflow", async () => {
    const graph = await loadWorkflow("auto-status.awf.kdl");
    const logs = await tempDir();

    // implement is a plain box node with no auto_status
    const implNode = graph.nodes.find((n) => n.id === "implement")!;
    expect(implNode.attrs.auto_status).toBeUndefined();

    const backend = statusAwareBackend({
      implement: "Here is the code.\n[STATUS: fail]\n[FAILURE_REASON: Oops]",
      review: "All good.\n[STATUS: success]",
    });

    const result = await runPipeline({ graph, logsRoot: logs, backend });

    // implement has no auto_status → markers ignored → treated as success
    expect(result.status).toBe("success");
    expect(result.completedNodes).toContain("implement");
    expect(result.completedNodes).toContain("review");
    expect(result.completedNodes).toContain("exit");
  });
});

// ===========================================================================
// 21. Workflow logical routing end-to-end
// ===========================================================================

describe("Workflow expression routing", () => {
  it("routes via !exists branch when blocker output is absent", async () => {
    const graph = await loadWorkflow("logic-routing.awf.kdl");
    const logs = await tempDir();

    const backend = nodeOutcomeBackend({
      build: {
        status: "success",
        context_updates: {
          "build.review": "fail",
        },
      },
    });

    const result = await runPipeline({ graph, logsRoot: logs, backend });

    expect(result.status).toBe("success");
    expect(result.completedNodes).toContain("pass");
    expect(result.completedNodes).not.toContain("fix");
  });

  it("routes via OR fallback branch when blocker exists", async () => {
    const graph = await loadWorkflow("logic-routing.awf.kdl");
    const logs = await tempDir();

    const backend = nodeOutcomeBackend({
      build: {
        status: "success",
        context_updates: {
          "build.blocker": "yes",
          "build.review": "pass",
        },
      },
    });

    const result = await runPipeline({ graph, logsRoot: logs, backend });

    expect(result.status).toBe("success");
    expect(result.completedNodes).toContain("pass");
    expect(result.completedNodes).not.toContain("fix");
  });

  it("routes via != conjunction when risk is not high", async () => {
    const graph = await loadWorkflow("logic-routing-neq.awf.kdl");
    const logs = await tempDir();

    const backend = nodeOutcomeBackend({
      build: {
        status: "success",
        context_updates: {
          "build.risk": "low",
        },
      },
    });

    const result = await runPipeline({ graph, logsRoot: logs, backend });

    expect(result.status).toBe("success");
    expect(result.completedNodes).toContain("ship");
    expect(result.completedNodes).not.toContain("fix");
  });

  it("falls through to fix when != conjunction fails", async () => {
    const graph = await loadWorkflow("logic-routing-neq.awf.kdl");
    const logs = await tempDir();

    const backend = nodeOutcomeBackend({
      build: {
        status: "success",
        context_updates: {
          "build.risk": "high",
        },
      },
    });

    const result = await runPipeline({ graph, logsRoot: logs, backend });

    expect(result.status).toBe("success");
    expect(result.completedNodes).toContain("fix");
    expect(result.completedNodes).not.toContain("ship");
  });

  it("routes to exit when build succeeds (complementary success path)", async () => {
    const graph = await loadWorkflow("fail-no-route.awf.kdl");
    const logs = await tempDir();

    const backend = nodeOutcomeBackend({
      build: { status: "success" },
    });

    const result = await runPipeline({ graph, logsRoot: logs, backend });

    expect(result.status).toBe("success");
    expect(result.completedNodes).toEqual(["__start__", "build", "exit"]);
  });

  it("fails pipeline when a failed stage has no matching failure transition", async () => {
    const graph = await loadWorkflow("fail-no-route.awf.kdl");
    const logs = await tempDir();
    const { events, onEvent } = eventCollector();

    const backend = nodeOutcomeBackend({
      build: { status: "fail", failure_reason: "build failed" },
    });

    const result = await runPipeline({ graph, logsRoot: logs, backend, onEvent });

    expect(result.status).toBe("fail");
    expect(result.completedNodes).toEqual(["__start__", "build"]);
    expect(events.map((e) => e.kind)).toContain("pipeline_failed");
    const failEvent = events.find((e) => e.kind === "pipeline_failed")!;
    expect(failEvent.data.error).toMatch(
      /no outgoing edge.*build/i,
    );
    expect(result.failureSummary?.failedNode).toBe("build");
    expect(result.failureSummary?.failureReason).toBe("build failed");
    expect(result.lastOutcome?.failure_reason).toBe("build failed");
    // Engine must not have started the "exit" stage at all.
    const startedStages = events
      .filter((e) => e.kind === "stage_started")
      .map((e) => e.data.name);
    expect(startedStages).not.toContain("exit");
  });
});
