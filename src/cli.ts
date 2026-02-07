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
import { resolve } from "node:path";
import { parseDot, validate, validateOrRaise, runPipeline, LlmBackend } from "./pipeline/index.js";
import type { PipelineEvent, Diagnostic, CodergenBackend } from "./pipeline/index.js";
import { Client, AnthropicAdapter, listModels } from "./llm/index.js";

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
  --model <model>        LLM model to use (default: claude-sonnet-4-5)
  --provider <name>      Provider name (default: anthropic)
  --logs <dir>           Logs directory (default: .attractor/logs)
  --system <prompt>      System prompt for codergen stages
  --temperature <n>      Temperature 0-1 (default: provider default)
  --max-tokens <n>       Max response tokens (default: 8192)
  --dry-run              Validate and print graph without executing
  --verbose              Show detailed event output

Environment:
  ANTHROPIC_API_KEY      API key for Anthropic provider
  ANTHROPIC_BASE_URL     Custom base URL for Anthropic API
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

function eventIcon(kind: string): string {
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
  return icons[kind] ?? "·";
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
  validateOrRaise(graph);

  const modelName = (args.model as string) ?? "claude-sonnet-4-5";
  const providerName = (args.provider as string) ?? "anthropic";
  const logsRoot = (args.logs as string) ?? ".attractor/logs";
  const verbose = args.verbose === true;
  const dryRun = args["dry-run"] === true;

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

  // Build LLM client
  let backend: CodergenBackend;
  try {
    const client = buildClient(providerName);
    backend = new LlmBackend({
      client,
      model: modelName,
      provider: providerName,
      systemPrompt: args.system as string | undefined,
      maxTokens: args["max-tokens"] ? parseInt(args["max-tokens"] as string, 10) : undefined,
      temperature: args.temperature ? parseFloat(args.temperature as string) : undefined,
    });
  } catch (err) {
    console.error(`Error configuring LLM: ${err}`);
    process.exit(1);
  }

  console.log(`┌─ Attractor Pipeline ─────────────────────────────┐`);
  console.log(`│  ${(graph.attrs.goal ?? graph.name).slice(0, 48).padEnd(48)} │`);
  console.log(`│  Model: ${modelName.padEnd(39)} │`);
  console.log(`│  Nodes: ${String(graph.nodes.length).padEnd(39)} │`);
  console.log(`└──────────────────────────────────────────────────┘`);
  console.log();

  const startTime = Date.now();

  const result = await runPipeline({
    graph,
    logsRoot,
    backend,
    onEvent(event: PipelineEvent) {
      const d = event.data as Record<string, unknown>;
      if (verbose) {
        console.log(
          `  ${eventIcon(event.kind)} ${event.kind.padEnd(20)} ${JSON.stringify(d)}`,
        );
      } else {
        switch (event.kind) {
          case "pipeline_started":
            console.log("  🚀 Pipeline started\n");
            break;
          case "stage_started":
            process.stdout.write(
              `  ▶️  ${String(d.name).padEnd(20)}`,
            );
            break;
          case "stage_completed":
            process.stdout.write("✅\n");
            break;
          case "stage_failed":
            process.stdout.write(`💥 ${d.error}\n`);
            break;
          case "pipeline_completed":
            console.log(`\n  🏁 Pipeline completed (${((Date.now() - startTime) / 1000).toFixed(1)}s)`);
            break;
          case "pipeline_failed":
            console.log(`\n  ❌ Pipeline failed: ${d.error}`);
            break;
        }
      }
    },
  });

  console.log();
  console.log(`  Status: ${result.status}`);
  console.log(`  Path:   ${result.completedNodes.join(" → ")}`);
  console.log(`  Logs:   ${resolve(logsRoot)}`);

  if (result.status === "fail") process.exit(1);
}

function cmdListModels(args: Record<string, string | boolean>): void {
  const provider = args.provider as string | undefined;
  const models = listModels(provider);

  if (models.length === 0) {
    console.log(provider ? `No models found for provider "${provider}".` : "No models in catalog.");
    return;
  }

  console.log(
    `${"Model".padEnd(30)} ${"Provider".padEnd(12)} ${"Context".padEnd(10)} Tools  Vision Reasoning`,
  );
  console.log("─".repeat(90));
  for (const m of models) {
    console.log(
      `${m.id.padEnd(30)} ${m.provider.padEnd(12)} ${String(m.context_window).padEnd(10)} ${yn(m.supports_tools)}     ${yn(m.supports_vision)}  ${yn(m.supports_reasoning)}`,
    );
  }
}

function yn(v: boolean): string {
  return v ? "✓" : "·";
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

function buildClient(providerName: string): Client {
  const providers: Record<string, () => import("./llm/types.js").ProviderAdapter> = {
    anthropic: () => new AnthropicAdapter(),
  };

  const factory = providers[providerName];
  if (!factory) {
    const available = Object.keys(providers).join(", ");
    throw new Error(
      `Unknown provider "${providerName}". Available: ${available}`,
    );
  }

  return new Client({
    providers: { [providerName]: factory() },
    default_provider: providerName,
  });
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
