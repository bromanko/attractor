#!/usr/bin/env node
/**
 * Attractor CLI — run and validate DOT-defined AI pipelines.
 *
 * Usage:
 *   attractor run <pipeline.dot> [options]
 *   attractor validate <pipeline.dot>
 *   attractor list-models [--provider <name>]
 */

import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { parseDot, validate, validateOrRaise, runPipeline, PiBackend, AutoApproveInterviewer } from "./pipeline/index.js";
import type { PipelineEvent, Diagnostic, CodergenBackend, ToolMode, Interviewer, Checkpoint, Graph } from "./pipeline/index.js";
import {
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { InteractiveInterviewer } from "./interactive-interviewer.js";
import {
  renderBanner,
  renderSummary,
  renderResumeInfo,
  renderMarkdown,
  Spinner,
  formatDuration,
} from "./cli-renderer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function usage(): never {
  console.log(`
attractor — DOT-based AI pipeline runner

Usage:
  attractor run <pipeline.dot> [options]   Run a pipeline
  attractor validate <pipeline.dot>        Validate a pipeline graph
  attractor list-models [--provider name]  Show available models

Run options:
  --goal <text>          Override the graph's goal attribute
  --model <model>        LLM model to use (default: claude-opus-4-6)
  --provider <name>      Provider name (default: anthropic)
  --logs <dir>           Logs directory (default: .attractor/logs)
  --system <prompt>      System prompt for codergen stages
  --tools <mode>         Tool mode: none | read-only | coding (default: coding)
  --approve-all          Auto-approve all human gates (no interactive prompts)
  --resume [checkpoint]  Resume from checkpoint (default: <logs>/checkpoint.json)
  --dry-run              Validate and print graph without executing
  --verbose              Show detailed event output

Auth:
  Uses pi's AuthStorage for credentials. Set ANTHROPIC_API_KEY in env,
  or use \`pi /login\` to authenticate with a Claude subscription.
`.trim());
  process.exit(1);
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  if (positional[0]) args._command = positional[0];
  if (positional[1]) args._file = positional[1];

  return args;
}

function severityIcon(severity: Diagnostic["severity"]): string {
  switch (severity) {
    case "error": return "❌";
    case "warning": return "⚠️ ";
    case "info": return "ℹ️ ";
  }
}

/**
 * Resolve the per-stage model for a node, if it differs from the default.
 * Returns undefined if the node uses the default model.
 */
function getStageModel(nodeId: string, graph: Graph, defaultModel: string): string | undefined {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return undefined;
  const nodeModel = node.attrs.llm_model as string | undefined;
  if (nodeModel && nodeModel !== defaultModel) return nodeModel;
  return undefined;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdValidate(filePath: string): Promise<void> {
  const dot = await readFile(resolve(filePath), "utf-8");
  const graph = parseDot(dot);
  const diagnostics = validate(graph);
  const errors = diagnostics.filter((d) => d.severity === "error");
  const warnings = diagnostics.filter((d) => d.severity === "warning");

  if (diagnostics.length === 0) {
    console.log(`✅ ${filePath}: valid (${graph.nodes.length} nodes, ${graph.edges.length} edges)`);
    console.log(`   Goal: ${graph.attrs.goal ?? "(none)"}`);
    console.log(`   Start: ${graph.nodes.find((n) => n.attrs.shape === "Mdiamond")?.id ?? "?"}`);
    console.log(`   Exit:  ${graph.nodes.filter((n) => n.attrs.shape === "Msquare").map((n) => n.id).join(", ") || "?"}`);
    return;
  }

  for (const d of diagnostics) {
    const location = d.node_id ? ` (node: ${d.node_id})` : d.edge ? ` (edge: ${d.edge[0]} → ${d.edge[1]})` : "";
    console.log(`${severityIcon(d.severity)} [${d.rule}]${location}: ${d.message}`);
    if (d.fix) console.log(`   Fix: ${d.fix}`);
  }

  console.log();
  console.log(
    `${errors.length} error(s), ${warnings.length} warning(s)`,
  );

  if (errors.length > 0) process.exit(1);
}

async function cmdRun(
  filePath: string,
  args: Record<string, string | boolean>,
): Promise<void> {
  const dot = await readFile(resolve(filePath), "utf-8");
  const graph = parseDot(dot);

  // Apply --goal override before validation
  if (args.goal && typeof args.goal === "string") {
    graph.attrs.goal = args.goal;
  }

  validateOrRaise(graph);

  const modelName = (args.model as string) ?? "claude-opus-4-6";
  const providerName = (args.provider as string) ?? "anthropic";
  const logsRoot = (args.logs as string) ?? ".attractor/logs";
  const verbose = args.verbose === true;
  const dryRun = args["dry-run"] === true;
  const toolMode = ((args.tools as string) ?? "coding") as ToolMode;

  if (dryRun) {
    console.log(`Graph: ${graph.name}`);
    console.log(`Goal:  ${graph.attrs.goal ?? "(none)"}`);
    console.log(`Nodes: ${graph.nodes.length}`);
    console.log(`Edges: ${graph.edges.length}`);
    console.log();
    console.log("Nodes:");
    for (const node of graph.nodes) {
      const shape = node.attrs.shape ?? "box";
      const label = node.attrs.label ?? node.id;
      console.log(`  ${node.id.padEnd(20)} [${shape}] ${label}`);
    }
    console.log();
    console.log("Edges:");
    for (const edge of graph.edges) {
      const label = edge.attrs.label ? ` "${edge.attrs.label}"` : "";
      const cond = edge.attrs.condition ? ` if(${edge.attrs.condition})` : "";
      console.log(`  ${edge.from} → ${edge.to}${label}${cond}`);
    }
    return;
  }

  // Build interviewer
  const approveAll = args["approve-all"] === true;
  const interviewer: Interviewer = approveAll
    ? new AutoApproveInterviewer()
    : new InteractiveInterviewer();

  // Build pi SDK backend
  let backend: CodergenBackend;
  try {
    const authStorage = new AuthStorage();
    const modelRegistry = new ModelRegistry(authStorage);

    backend = new PiBackend({
      model: modelName,
      provider: providerName,
      cwd: process.cwd(),
      systemPrompt: args.system as string | undefined,
      toolMode,
      authStorage,
      modelRegistry,
    });
  } catch (err) {
    console.error(`Error configuring backend: ${err}`);
    process.exit(1);
  }

  // Display banner
  console.log(renderBanner({
    goal: graph.attrs.goal ?? graph.name,
    defaultModel: modelName,
    toolMode,
    nodeCount: graph.nodes.length,
  }));

  // Load checkpoint for --resume
  let checkpoint: Checkpoint | undefined;
  if (args.resume !== undefined) {
    const cpPath = typeof args.resume === "string"
      ? resolve(args.resume)
      : join(resolve(logsRoot), "checkpoint.json");

    if (!existsSync(cpPath)) {
      console.log(`  ℹ️  No checkpoint found, starting fresh.`);
      console.log();
    } else {
      try {
        checkpoint = JSON.parse(await readFile(cpPath, "utf-8")) as Checkpoint;
        const resumeAt = checkpoint.resume_at ?? checkpoint.current_node;
        console.log(renderResumeInfo(checkpoint, resumeAt));
      } catch (err) {
        console.error(`Error reading checkpoint: ${err}`);
        process.exit(1);
      }
    }
  }

  const startTime = Date.now();
  const spinner = new Spinner();

  const result = await runPipeline({
    graph,
    logsRoot,
    backend,
    interviewer,
    checkpoint,
    onEvent(event: PipelineEvent) {
      const d = event.data as Record<string, unknown>;
      if (verbose) {
        const icons: Record<string, string> = {
          pipeline_started: "🚀",
          stage_started: "▶️ ",
          stage_completed: "✅",
          stage_failed: "💥",
          stage_retrying: "🔄",
          checkpoint_saved: "💾",
          pipeline_completed: "🏁",
          pipeline_failed: "❌",
          interview_started: "🙋",
          interview_completed: "✍️ ",
        };
        const icon = icons[event.kind] ?? "·";
        console.log(
          `  ${icon} ${event.kind.padEnd(20)} ${JSON.stringify(d)}`,
        );
      } else {
        switch (event.kind) {
          case "pipeline_started":
            console.log("  🚀 Pipeline started\n");
            break;
          case "pipeline_resumed":
            console.log(`  ♻️  Resuming at: ${d.from}\n`);
            break;
          case "stage_started": {
            const stageModel = getStageModel(String(d.name), graph, modelName);
            spinner.start(String(d.name), stageModel);
            break;
          }
          case "stage_completed":
            spinner.stop("success");
            break;
          case "stage_failed": {
            const errorMsg = d.error ? String(d.error) : undefined;
            // Render failure reason as markdown if it contains markdown formatting
            const rendered = errorMsg && /[#*`\[\]\n]/.test(errorMsg)
              ? renderMarkdown(errorMsg)
              : errorMsg;
            spinner.stop("fail", rendered);
            break;
          }
          case "stage_retrying":
            spinner.stop("retry");
            break;
          case "pipeline_completed":
            console.log(`\n  🏁 Pipeline completed (${formatDuration(Date.now() - startTime)})`);
            break;
          case "pipeline_failed":
            console.log(`\n  ❌ Pipeline failed: ${d.error}`);
            break;
        }
      }
    },
  });

  console.log(renderSummary({
    status: result.status,
    completedNodes: result.completedNodes,
    logsRoot: resolve(logsRoot),
    elapsedMs: Date.now() - startTime,
  }));

  if (result.status === "fail") process.exit(1);
}

function cmdListModels(args: Record<string, string | boolean>): void {
  const providerFilter = args.provider as string | undefined;

  const authStorage = new AuthStorage();
  const modelRegistry = new ModelRegistry(authStorage);
  const models = modelRegistry.getAvailable();

  const filtered = providerFilter
    ? models.filter((m) => m.provider === providerFilter)
    : models;

  if (filtered.length === 0) {
    console.log(providerFilter
      ? `No authenticated models found for provider "${providerFilter}".`
      : "No authenticated models found. Run \`pi /login\` or set API key env vars.");
    return;
  }

  console.log(`${"Model".padEnd(30)} ${"Provider".padEnd(12)} ${"Context".padEnd(10)} Reasoning`);
  console.log("─".repeat(65));
  for (const m of filtered) {
    console.log(
      `${m.id.padEnd(30)} ${String(m.provider).padEnd(12)} ${String(m.contextWindow).padEnd(10)} ${m.reasoning ? "✓" : "·"}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args._command) {
    case "run": {
      if (!args._file) {
        console.error("Error: run requires a .dot file path");
        usage();
      }
      await cmdRun(args._file as string, args);
      break;
    }
    case "validate": {
      if (!args._file) {
        console.error("Error: validate requires a .dot file path");
        usage();
      }
      await cmdValidate(args._file as string);
      break;
    }
    case "list-models": {
      cmdListModels(args);
      break;
    }
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message ?? err}`);
  process.exit(1);
});
