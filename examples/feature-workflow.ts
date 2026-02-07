/**
 * Realistic feature implementation workflow.
 *
 * Demonstrates: conditional branching, loop-backs on failure,
 * goal gates, context threading, and checkpoint artifacts.
 *
 *   npx tsx examples/feature-workflow.ts
 */

import { parseDot, validateOrRaise, runPipeline } from "../src/pipeline/index.js";
import { Context } from "../src/pipeline/types.js";
import type { CodergenBackend, GraphNode, Outcome, PipelineEvent } from "../src/pipeline/index.js";
import { readFile } from "node:fs/promises";

// -----------------------------------------------------------------------
// 1. The pipeline — a DOT graph
// -----------------------------------------------------------------------

const dot = `
digraph ImplementFeature {
    graph [
        goal="Add rate limiting middleware to the Express API"
        label="Feature Implementation Pipeline"
    ]

    // Defaults for all nodes
    node [shape=box]

    // Entry / exit
    start  [shape=Mdiamond, label="Start"]
    done   [shape=Msquare,  label="Done"]

    // Planning phase
    analyze [
        label="Analyze Codebase"
        prompt="Read the existing Express middleware stack and identify where rate limiting should be added. List the files that need changes."
    ]

    plan [
        label="Plan Implementation"
        prompt="Given the analysis, create a step-by-step plan to add rate limiting. Include: middleware placement, configuration, storage backend, and per-route limits."
        goal_gate=true
    ]

    // Implementation phase
    implement [
        label="Implement"
        prompt="Follow the plan to implement rate limiting. Create the middleware, add configuration, and wire it into the Express app."
        goal_gate=true
    ]

    // Validation phase
    write_tests [
        label="Write Tests"
        prompt="Write tests for the rate limiter: unit tests for the middleware logic, integration tests for rate limit headers and 429 responses."
    ]

    run_tests [
        label="Run Tests"
        prompt="Execute the test suite. Report pass/fail counts and any failures."
    ]

    // Decision gate
    tests_pass [shape=diamond, label="Tests passing?"]

    // Fix loop
    diagnose [
        label="Diagnose Failures"
        prompt="Analyze the test failures. Identify root causes and propose fixes."
    ]

    fix [
        label="Apply Fixes"
        prompt="Apply the proposed fixes from the diagnosis step."
    ]

    // Flow
    start -> analyze -> plan -> implement -> write_tests -> run_tests -> tests_pass

    // Happy path
    tests_pass -> done [label="Yes", condition="outcome=success", weight=10]

    // Failure loop — goes back through fix cycle
    tests_pass -> diagnose [label="No", condition="outcome!=success"]
    diagnose -> fix -> run_tests
}
`;

// -----------------------------------------------------------------------
// 2. A simulated backend that mimics LLM behavior
// -----------------------------------------------------------------------

// Track how many times we've been through the fix loop
let fixAttempts = 0;

const backend: CodergenBackend = {
  async run(node: GraphNode, prompt: string, context: Context): Promise<Outcome> {
    await pause(150); // Simulate LLM latency

    switch (node.id) {
      case "analyze":
        return success(node, {
          notes: "Found Express app in src/app.ts with 3 existing middleware layers",
          context_updates: {
            "files.identified": "src/app.ts, src/middleware/index.ts, src/config.ts",
            "middleware.count": "3",
          },
        });

      case "plan":
        return success(node, {
          notes: [
            "Plan:",
            "1. Create src/middleware/rate-limiter.ts",
            "2. Add config schema in src/config.ts",
            "3. Wire into app before route handlers",
            "4. Use sliding window algorithm with Map storage",
          ].join("\n"),
          context_updates: {
            "plan.files": "rate-limiter.ts, config.ts, app.ts",
            "plan.algorithm": "sliding-window",
          },
        });

      case "implement":
        return success(node, {
          notes: "Created rate-limiter.ts (87 lines), updated config.ts and app.ts",
          context_updates: {
            "impl.lines_added": "127",
            "impl.files_changed": "3",
          },
        });

      case "write_tests":
        return success(node, {
          notes: "Wrote 12 test cases across 2 test files",
          context_updates: { "tests.count": "12" },
        });

      case "run_tests": {
        // First run fails, second succeeds (simulates the fix loop)
        fixAttempts++;
        if (fixAttempts <= 1) {
          return {
            status: "fail",
            failure_reason: "2 of 12 tests failed: rate limit header format incorrect",
            context_updates: {
              "tests.passed": "10",
              "tests.failed": "2",
              "tests.failure_detail": "X-RateLimit-Remaining header returns string instead of number",
            },
          };
        }
        return success(node, {
          notes: "All 12 tests passing",
          context_updates: {
            "tests.passed": "12",
            "tests.failed": "0",
          },
        });
      }

      case "diagnose":
        return success(node, {
          notes: "Root cause: rate-limiter.ts sets header with String() instead of Number(). Fix: change line 42.",
          context_updates: {
            "diagnosis": "Header type mismatch — String vs Number",
            "fix.target": "src/middleware/rate-limiter.ts:42",
          },
        });

      case "fix":
        return success(node, {
          notes: "Fixed header type in rate-limiter.ts line 42",
          context_updates: { "fix.applied": "true" },
        });

      default:
        return { status: "success" };
    }
  },
};

function success(node: GraphNode, extra: Partial<Outcome> = {}): Outcome {
  return { status: "success", notes: `Completed ${node.id}`, ...extra };
}

function pause(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// -----------------------------------------------------------------------
// 3. Run it
// -----------------------------------------------------------------------

const graph = parseDot(dot);
validateOrRaise(graph);

console.log("┌─────────────────────────────────────────────────┐");
console.log("│  Attractor Pipeline: Feature Implementation     │");
console.log("└─────────────────────────────────────────────────┘");
console.log();
console.log(`  Goal: ${graph.attrs.goal}`);
console.log(`  Nodes: ${graph.nodes.length}  Edges: ${graph.edges.length}`);
console.log();

const result = await runPipeline({
  graph,
  logsRoot: "/tmp/attractor-feature-example",
  backend,
  onEvent(event: PipelineEvent) {
    const d = event.data as Record<string, unknown>;
    switch (event.kind) {
      case "pipeline_started":
        console.log("  ▸ Pipeline started\n");
        break;
      case "stage_started":
        process.stdout.write(`  ● ${String(d.name).padEnd(16)}`);
        break;
      case "stage_completed":
        process.stdout.write("  ✅\n");
        break;
      case "stage_failed":
        process.stdout.write(`  ❌  ${d.error}\n`);
        break;
      case "pipeline_completed":
        console.log("\n  ▸ Pipeline completed");
        break;
      case "pipeline_failed":
        console.log(`\n  ▸ Pipeline failed: ${d.error}`);
        break;
    }
  },
});

// -----------------------------------------------------------------------
// 4. Show results
// -----------------------------------------------------------------------

console.log();
console.log("  ── Results ──────────────────────────────────────");
console.log(`  Status: ${result.status}`);
console.log(`  Path:   ${result.completedNodes.join(" → ")}`);
console.log();

// Show checkpoint context
const cpJson = await readFile("/tmp/attractor-feature-example/checkpoint.json", "utf-8");
const checkpoint = JSON.parse(cpJson);
console.log("  ── Final Context ────────────────────────────────");
for (const [key, value] of Object.entries(checkpoint.context_values).sort()) {
  if (!key.startsWith("graph.")) {
    console.log(`  ${key.padEnd(28)} ${value}`);
  }
}
console.log();

// Show per-stage artifacts
console.log("  ── Stage Artifacts ──────────────────────────────");
for (const nodeId of result.completedNodes) {
  try {
    const status = JSON.parse(
      await readFile(`/tmp/attractor-feature-example/${nodeId}/status.json`, "utf-8")
    );
    const notes = status.notes ? `: ${status.notes.split("\n")[0]}` : "";
    console.log(`  ${nodeId.padEnd(16)} [${status.outcome}]${notes}`);
  } catch {
    console.log(`  ${nodeId.padEnd(16)} [handler: ${nodeId === "start" || nodeId === "done" ? "built-in" : "—"}]`);
  }
}
