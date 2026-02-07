/**
 * Minimal example: run a DOT-defined pipeline with a simulated backend.
 *
 *   npx tsx examples/hello-pipeline.ts
 */

import { parseDot, validateOrRaise, runPipeline } from "../src/pipeline/index.js";
import type { CodergenBackend, PipelineEvent } from "../src/pipeline/index.js";

// -- 1. Define a pipeline in DOT syntax ---------------------------------

const dot = `
digraph FeaturePipeline {
    graph [goal="Add a /health endpoint that returns JSON"]

    start     [shape=Mdiamond, label="Start"]
    exit      [shape=Msquare,  label="Exit"]
    plan      [label="Plan",       prompt="Break $goal into steps"]
    implement [label="Implement",  prompt="Write code for: $goal", goal_gate=true]
    validate  [label="Validate",   prompt="Run tests and verify $goal works"]
    gate      [shape=diamond,      label="Tests pass?"]

    start -> plan -> implement -> validate -> gate
    gate -> exit      [label="Yes", condition="outcome=success"]
    gate -> implement [label="No",  condition="outcome!=success"]
}
`;

// -- 2. Parse & validate ------------------------------------------------

const graph = parseDot(dot);
const diagnostics = validateOrRaise(graph);   // throws on errors
console.log("✅ Graph validated:", graph.nodes.length, "nodes,", graph.edges.length, "edges");
console.log("   Goal:", graph.attrs.goal);
console.log();

// -- 3. Provide a backend (replace with real LLM integration) -----------

const simBackend: CodergenBackend = {
  async run(node, prompt, _context) {
    console.log(`   🤖 [${node.id}] prompt: "${prompt.slice(0, 60)}…"`);

    // Simulate work
    await new Promise((r) => setTimeout(r, 100));

    return {
      status: "success" as const,
      notes: `Completed ${node.id}`,
      context_updates: { [`${node.id}.done`]: "true" },
    };
  },
};

// -- 4. Run -------------------------------------------------------------

const result = await runPipeline({
  graph,
  logsRoot: "/tmp/attractor-example",
  backend: simBackend,
  onEvent(event: PipelineEvent) {
    const icon: Record<string, string> = {
      pipeline_started:  "🚀",
      stage_started:     "▶️ ",
      stage_completed:   "✅",
      checkpoint_saved:  "💾",
      pipeline_completed:"🏁",
      pipeline_failed:   "❌",
      stage_failed:      "💥",
    };
    console.log(`   ${icon[event.kind] ?? "·"} ${event.kind}`, JSON.stringify(event.data));
  },
});

console.log();
console.log("Result:", result.status);
console.log("Path:", result.completedNodes.join(" → "));
console.log("Logs:", "/tmp/attractor-example/");
