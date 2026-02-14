/**
 * attractor.ts — Pi CLI extension entry point.
 *
 * Registers `/attractor` as a command-only extension providing `run` and
 * `validate` subcommands. This is the installable pi package entry point.
 */

import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { hasGraphEasy, runGraphEasy } from "../pipeline/graph-easy.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import {
  runPipeline,
  PiBackend,
  AutoApproveInterviewer,
  parseWorkflowKdl,
  validateWorkflow,
  workflowToGraph,
  graphToDot,
} from "../pipeline/index.js";
import type {
  PipelineEvent,
  Diagnostic,
  Checkpoint,
  Graph,
  Interviewer,
  CodergenBackend,
  ToolMode,
  WorkflowDefinition,
} from "../pipeline/index.js";
import { parseCommand, CommandParseError, discoverWorkflows } from "./attractor-command.js";
import type { ParsedRunCommand, ParsedValidateCommand, ParsedShowCommand, ShowFormat, WorkflowCatalogEntry } from "./attractor-command.js";
import { PiInterviewer } from "./attractor-interviewer.js";
import { AttractorPanel, CUSTOM_MESSAGE_TYPE } from "./attractor-panel.js";
import type { StageMessageDetails } from "./attractor-panel.js";
import { Box, Text } from "@mariozechner/pi-tui";

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function attractorExtension(pi: ExtensionAPI): void {
  // Register message renderer for stage results in the conversation area
  pi.registerMessageRenderer(CUSTOM_MESSAGE_TYPE, (message, { expanded }, theme) => {
    const details = message.details as StageMessageDetails | undefined;
    if (!details) {
      const text = typeof message.content === "string" ? message.content : "";
      return new Text(text, 0, 0);
    }

    const isSuccess = details.state === "success";
    const bgColor = isSuccess ? "toolSuccessBg" : "toolErrorBg";
    const icon = isSuccess ? theme.fg("success", "✔") : theme.fg("error", "✘");
    const elapsed = details.elapsed ? theme.fg("dim", ` (${details.elapsed})`) : "";
    const header = `${icon} ${theme.bold(details.stage)}${elapsed}`;

    let body = "";
    if (isSuccess && details.output) {
      body = "\n" + details.output;
    } else if (!isSuccess && details.error) {
      body = "\n" + details.error;
    }

    // In collapsed mode, truncate body
    if (!expanded && body.length > 300) {
      body = body.slice(0, 300) + "…";
    }

    const box = new Box(1, 1, (t: string) => theme.bg(bgColor, t));
    box.addChild(new Text(header + body, 0, 0));
    return box;
  });

  pi.registerCommand("attractor", {
    description: "Run or validate Attractor workflows (.awf.kdl)",

    getArgumentCompletions: (prefix: string) => {
      const subcommands = [
        { value: "run", label: "run — Execute a pipeline" },
        { value: "validate", label: "validate — Check pipeline graph" },
        { value: "show", label: "show — Visualize a pipeline graph" },
      ];

      // If prefix is empty or partially matches a subcommand, show subcommands
      const trimmed = prefix.trim();
      if (!trimmed.includes(" ")) {
        const filtered = subcommands.filter((s) => s.value.startsWith(trimmed));
        return filtered.length > 0 ? filtered : null;
      }

      // After subcommand, complete workflow names
      // (async discovery not available in sync completions — use cached entries)
      return null;
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
        case "show":
          await handleShow(parsed, ctx, pi);
          break;
        case "run":
          await handleRun(parsed, ctx, pi);
          break;
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Guided workflow selection + goal prompt
// ---------------------------------------------------------------------------

async function pickWorkflow(
  ctx: ExtensionCommandContext,
): Promise<WorkflowCatalogEntry | undefined> {
  const { entries, warnings } = await discoverWorkflows(ctx.cwd, parseWorkflowKdl);

  for (const w of warnings) {
    ctx.ui.notify(w, "warning");
  }

  if (entries.length === 0) {
    ctx.ui.notify(
      "No workflows found in .attractor/workflows/\n" +
      "Place .awf.kdl files there or provide a workflow path directly.",
      "error",
    );
    return undefined;
  }

  const options = entries.map((e) => ({
    value: e.name,
    label: e.description
      ? `${e.name} — ${e.description} (${e.stageCount} stages)`
      : `${e.name} (${e.stageCount} stages)`,
  }));

  const selected = await ctx.ui.select("Select a workflow", options);
  if (selected === undefined) return undefined;

  return entries.find((e) => e.name === selected);
}

async function promptGoal(
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  while (true) {
    const goal = await ctx.ui.input("Enter the pipeline goal");
    if (goal === undefined) return undefined; // cancelled
    const trimmed = goal.trim();
    if (trimmed.length > 0) return trimmed;
    ctx.ui.notify("Goal cannot be empty. Please enter a goal or press Escape to cancel.", "warning");
  }
}

function formatWorkflowPreview(
  workflow: WorkflowDefinition,
  workflowPath: string,
): string {
  const lines: string[] = [];
  lines.push(`Workflow: ${workflow.name}`);
  if (workflow.description) {
    lines.push(`Description: ${workflow.description}`);
  }
  lines.push(`Path: ${workflowPath}`);
  lines.push(`Stages: ${workflow.stages.length}`);
  lines.push(`Start: ${workflow.start}`);
  const exits = workflow.stages.filter((s) => s.kind === "exit").map((s) => s.id).join(", ") || "?";
  lines.push(`Exit: ${exits}`);
  return lines.join("\n");
}

function isKdlWorkflowPath(path: string): boolean {
  return path.toLowerCase().endsWith(".kdl");
}

function parseWorkflow(path: string, source: string): { graph: Graph; workflow: WorkflowDefinition } {
  if (!isKdlWorkflowPath(path)) {
    throw new Error("Only .awf.kdl workflow files are supported.");
  }
  const workflow = parseWorkflowKdl(source);
  return { graph: workflowToGraph(workflow), workflow };
}

// ---------------------------------------------------------------------------
// /attractor show
// ---------------------------------------------------------------------------


async function handleShow(
  cmd: ParsedShowCommand,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  const source = await readFile(cmd.workflowPath, "utf-8");
  const { graph } = parseWorkflow(cmd.workflowPath, source);
  const dot = graphToDot(graph);

  let format: ShowFormat = cmd.format ?? "boxart";
  const graphEasyAvailable = format !== "dot" && await hasGraphEasy();

  // If the desired format needs graph-easy but it's not available, fall back to dot
  if (format !== "dot" && !graphEasyAvailable) {
    ctx.ui.notify(
      "graph-easy not found — falling back to DOT output. " +
      "Install graph-easy for ASCII/boxart rendering.",
      "warning",
    );
    format = "dot";
  }

  if (format === "dot") {
    pi.sendMessage({
      customType: CUSTOM_MESSAGE_TYPE,
      content: "```dot\n" + dot + "```",
      display: true,
      details: { stage: graph.name, state: "success", output: dot } as StageMessageDetails,
    });
    return;
  }

  const rendered = await runGraphEasy(dot, format);
  pi.sendMessage({
    customType: CUSTOM_MESSAGE_TYPE,
    content: "```\n" + rendered + "```",
    display: true,
    details: { stage: graph.name, state: "success", output: rendered } as StageMessageDetails,
  });
}

// ---------------------------------------------------------------------------
// /attractor validate
// ---------------------------------------------------------------------------

async function handleValidate(
  cmd: ParsedValidateCommand,
  ctx: ExtensionCommandContext,
): Promise<void> {
  // Guided mode: prompt for workflow if not specified
  let workflowPath = cmd.workflowPath;
  if (!workflowPath) {
    const entry = await pickWorkflow(ctx);
    if (!entry) return;
    workflowPath = entry.path;
  }

  const source = await readFile(workflowPath, "utf-8");

  if (!isKdlWorkflowPath(workflowPath)) {
    throw new Error("Only .awf.kdl workflow files are supported.");
  }

  const workflow = parseWorkflowKdl(source);
  const diagnostics = validateWorkflow(workflow);
  const errors = diagnostics.filter((d: Diagnostic) => d.severity === "error");
  const warnings = diagnostics.filter((d: Diagnostic) => d.severity === "warning");

  if (diagnostics.length === 0) {
    const exits = workflow.stages.filter((s) => s.kind === "exit").map((s) => s.id).join(", ") || "?";
    ctx.ui.notify(
      `✅ Valid (${workflow.stages.length} stages)\n` +
      `Goal: ${workflow.goal ?? "(none)"}\n` +
      `Start: ${workflow.start} → Exit: ${exits}`,
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
  // Guided mode: prompt for workflow if not specified
  let workflowPath = cmd.workflowPath;
  if (!workflowPath) {
    const entry = await pickWorkflow(ctx);
    if (!entry) return;
    workflowPath = entry.path;
  }

  const source = await readFile(workflowPath, "utf-8");
  const parsed = parseWorkflow(workflowPath, source);
  const graph = parsed.graph;

  // Goal handling: prompt for goal on non-resume runs
  if (!cmd.resume) {
    // If workflow has no goal, prompt for one
    if (!parsed.workflow.goal) {
      const goal = await promptGoal(ctx);
      if (goal === undefined) return; // cancelled
      graph.attrs.goal = goal;
      parsed.workflow.goal = goal;
    }
  }

  // Show workflow preview
  ctx.ui.notify(formatWorkflowPreview(parsed.workflow, workflowPath), "info");

  const diags = validateWorkflow(parsed.workflow);
  const errors = diags.filter((d) => d.severity === "error");
  if (errors.length > 0) {
    const msg = errors.map((e) => `[${e.rule}] ${e.message}`).join("\n");
    throw new Error(`Workflow validation failed:\n${msg}`);
  }

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

  // Set up panel early so backend can stream events to it.
  // Wrap ctx.ui to add sendMessage (bridges to pi.sendMessage).
  const panelUI = {
    setStatus: (key: string, text: string | undefined) => ctx.ui.setStatus(key, text),
    notify: (message: string, type?: "info" | "warning" | "error") => ctx.ui.notify(message, type),
    sendMessage: (message: { customType: string; content: string; display: boolean; details: unknown }) => {
      pi.sendMessage(message as Parameters<typeof pi.sendMessage>[0]);
    },
  };
  const panel = new AttractorPanel(panelUI, ctx.ui.theme);

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
  // TODO: wire abort to a pi cancellation API when available
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
