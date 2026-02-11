/**
 * attractor.ts — Pi CLI extension entry point.
 *
 * Registers `/attractor` as a command-only extension providing `run` and
 * `validate` subcommands. This is the installable pi package entry point.
 */

import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import {
  parseDot,
  validate,
  validateOrRaise,
  runPipeline,
  PiBackend,
  AutoApproveInterviewer,
} from "../pipeline/index.js";
import type {
  PipelineEvent,
  Diagnostic,
  Checkpoint,
  Graph,
  Interviewer,
  CodergenBackend,
  ToolMode,
} from "../pipeline/index.js";
import { parseCommand, CommandParseError, usageText } from "./attractor-command.js";
import type { ParsedRunCommand, ParsedValidateCommand } from "./attractor-command.js";
import { PiInterviewer } from "./attractor-interviewer.js";
import { AttractorPanel } from "./attractor-panel.js";

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function attractorExtension(pi: ExtensionAPI): void {
  pi.registerCommand("attractor", {
    description: "Run or validate Attractor DOT pipelines",

    getArgumentCompletions: (prefix: string) => {
      const subcommands = [
        { value: "run", label: "run — Execute a pipeline" },
        { value: "validate", label: "validate — Check pipeline graph" },
      ];
      const filtered = subcommands.filter((s) => s.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },

    handler: async (args: string, ctx: ExtensionCommandContext) => {
      // Ensure we have UI
      if (!ctx.hasUI) {
        ctx.ui.notify(
          "/attractor requires interactive mode. Run pi without -p or --mode flags.",
          "error",
        );
        return;
      }

      let parsed;
      try {
        parsed = parseCommand(args, ctx.cwd);
      } catch (err) {
        if (err instanceof CommandParseError) {
          ctx.ui.notify(err.message, "error");
          return;
        }
        throw err;
      }

      switch (parsed.subcommand) {
        case "validate":
          await handleValidate(parsed, ctx);
          break;
        case "run":
          await handleRun(parsed, ctx, pi);
          break;
      }
    },
  });
}

// ---------------------------------------------------------------------------
// /attractor validate
// ---------------------------------------------------------------------------

async function handleValidate(
  cmd: ParsedValidateCommand,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const dot = await readFile(cmd.workflowPath, "utf-8");
  const graph = parseDot(dot);
  const diagnostics = validate(graph);
  const errors = diagnostics.filter((d: Diagnostic) => d.severity === "error");
  const warnings = diagnostics.filter((d: Diagnostic) => d.severity === "warning");

  if (diagnostics.length === 0) {
    const start = graph.nodes.find((n) => n.attrs.shape === "Mdiamond")?.id ?? "?";
    const exits = graph.nodes
      .filter((n) => n.attrs.shape === "Msquare")
      .map((n) => n.id)
      .join(", ") || "?";
    ctx.ui.notify(
      `✅ Valid (${graph.nodes.length} nodes, ${graph.edges.length} edges)\n` +
      `Goal: ${graph.attrs.goal ?? "(none)"}\n` +
      `Start: ${start} → Exit: ${exits}`,
      "info",
    );
    return;
  }

  const lines: string[] = [];
  for (const d of diagnostics) {
    const icon = d.severity === "error" ? "❌" : d.severity === "warning" ? "⚠️" : "ℹ️";
    const loc = d.node_id
      ? ` (node: ${d.node_id})`
      : d.edge
        ? ` (edge: ${d.edge[0]} → ${d.edge[1]})`
        : "";
    lines.push(`${icon} [${d.rule}]${loc}: ${d.message}`);
    if (d.fix) lines.push(`   Fix: ${d.fix}`);
  }
  lines.push("");
  lines.push(`${errors.length} error(s), ${warnings.length} warning(s)`);

  const type = errors.length > 0 ? "error" : "warning";
  ctx.ui.notify(lines.join("\n"), type as "error" | "warning");
}

// ---------------------------------------------------------------------------
// /attractor run
// ---------------------------------------------------------------------------

async function handleRun(
  cmd: ParsedRunCommand,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  const dot = await readFile(cmd.workflowPath, "utf-8");
  const graph = parseDot(dot);

  // Apply goal override
  if (cmd.goal) {
    graph.attrs.goal = cmd.goal;
  }

  validateOrRaise(graph);

  // Dry run
  if (cmd.dryRun) {
    const lines = [
      `Graph: ${graph.name}`,
      `Goal:  ${graph.attrs.goal ?? "(none)"}`,
      `Nodes: ${graph.nodes.length}`,
      `Edges: ${graph.edges.length}`,
      "",
      "Nodes:",
      ...graph.nodes.map((n) => {
        const shape = n.attrs.shape ?? "box";
        const label = n.attrs.label ?? n.id;
        return `  ${n.id} [${shape}] ${label}`;
      }),
      "",
      "Edges:",
      ...graph.edges.map((e) => {
        const label = e.attrs.label ? ` "${e.attrs.label}"` : "";
        const cond = e.attrs.condition ? ` if(${e.attrs.condition})` : "";
        return `  ${e.from} → ${e.to}${label}${cond}`;
      }),
    ];
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }

  const modelName = "claude-opus-4-6";
  const providerName = "anthropic";
  const logsRoot = cmd.logs ?? ".attractor/logs";
  const toolMode: ToolMode = (cmd.tools as ToolMode) ?? "coding";

  // Set up panel early so backend can stream events to it
  const panel = new AttractorPanel(ctx.ui, ctx.ui.theme);

  // Build backend (reuses CLI model/provider defaults)
  let backend: CodergenBackend;
  try {
    const authStorage = new AuthStorage();
    const modelRegistry = new ModelRegistry(authStorage);
    backend = new PiBackend({
      model: modelName,
      provider: providerName,
      cwd: ctx.cwd,
      toolMode,
      authStorage,
      modelRegistry,
      onStageEvent: (nodeId, agentEvent) => {
        // Bridge agent session events to pipeline events for the panel
        const ts = new Date().toISOString();
        switch (agentEvent.type) {
          case "message_update": {
            const msg = agentEvent.assistantMessageEvent as { type: string; delta?: string; content?: string };
            if (msg.type === "text_delta" && msg.delta) {
              panel.handleEvent({
                kind: "agent_text",
                timestamp: ts,
                data: { stageId: nodeId, text: msg.delta },
              });
            }
            break;
          }
          case "tool_execution_start":
            panel.handleEvent({
              kind: "agent_tool_start",
              timestamp: ts,
              data: {
                stageId: nodeId,
                toolName: agentEvent.toolName,
                toolCallId: agentEvent.toolCallId,
                args: agentEvent.args,
              },
            });
            break;
          case "tool_execution_end":
            panel.handleEvent({
              kind: "agent_tool_end",
              timestamp: ts,
              data: {
                stageId: nodeId,
                toolName: agentEvent.toolName,
                toolCallId: agentEvent.toolCallId,
                isError: agentEvent.isError,
              },
            });
            break;
        }
      },
    });
  } catch (err) {
    panel.dispose();
    ctx.ui.notify(`Backend configuration error: ${err}`, "error");
    return;
  }

  // Build interviewer
  const interviewer: Interviewer = cmd.approveAll
    ? new AutoApproveInterviewer()
    : new PiInterviewer(ctx.ui);

  // Load checkpoint for --resume
  let checkpoint: Checkpoint | undefined;
  if (cmd.resume) {
    const cpPath = join(resolve(logsRoot), "checkpoint.json");
    if (existsSync(cpPath)) {
      try {
        checkpoint = JSON.parse(await readFile(cpPath, "utf-8")) as Checkpoint;
      } catch (err) {
        panel.dispose();
        ctx.ui.notify(`Error reading checkpoint: ${err}`, "error");
        return;
      }
    } else {
      ctx.ui.notify("No checkpoint found, starting fresh.", "info");
    }
  }

  // Cancellation
  const abortController = new AbortController();
  const cancelCleanup = () => {
    abortController.abort();
  };

  // Provide a way to cancel via keyboard — register a temporary shortcut
  // (Note: we can't easily capture Ctrl+C in an extension command, so we
  // rely on the abort controller and potential future pi cancellation APIs)

  try {
    const result = await runPipeline({
      graph,
      logsRoot,
      backend,
      interviewer,
      checkpoint,
      abortSignal: abortController.signal,
      onEvent(event: PipelineEvent) {
        panel.handleEvent(event);
      },
    });

    panel.showSummary(result);

    if (result.status === "cancelled") {
      ctx.ui.notify("Pipeline was cancelled. Checkpoint saved for resume.", "warning");
    }
  } catch (err) {
    ctx.ui.notify(`Pipeline execution error: ${err}`, "error");
  } finally {
    panel.dispose();
  }
}
