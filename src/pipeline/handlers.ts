/**
 * Node Handlers — Section 4 of the Attractor Spec.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  SHAPE_TO_TYPE,
  type Handler, type GraphNode, type Context, type Graph, type Outcome,
  type Interviewer, type CodergenBackend, type Option, type Question,
} from "./types.js";

// ---------------------------------------------------------------------------
// Utility: write status file
// ---------------------------------------------------------------------------

async function writeStatus(stageDir: string, outcome: Outcome): Promise<void> {
  await mkdir(stageDir, { recursive: true });
  await writeFile(
    join(stageDir, "status.json"),
    JSON.stringify({
      outcome: outcome.status,
      preferred_next_label: outcome.preferred_label ?? "",
      suggested_next_ids: outcome.suggested_next_ids ?? [],
      context_updates: outcome.context_updates ?? {},
      notes: outcome.notes ?? "",
    }, null, 2),
    "utf-8",
  );
}

function expandVariables(text: string, graph: Graph, _context: Context): string {
  return text.replace(/\$goal/g, (graph.attrs.goal as string) ?? "");
}

// ---------------------------------------------------------------------------
// 4.3 Start Handler
// ---------------------------------------------------------------------------

export class StartHandler implements Handler {
  async execute(): Promise<Outcome> {
    return { status: "success" };
  }
}

// ---------------------------------------------------------------------------
// 4.4 Exit Handler
// ---------------------------------------------------------------------------

export class ExitHandler implements Handler {
  async execute(): Promise<Outcome> {
    return { status: "success" };
  }
}

// ---------------------------------------------------------------------------
// 4.5 Codergen Handler (LLM Task)
// ---------------------------------------------------------------------------

export class CodergenHandler implements Handler {
  private _backend: CodergenBackend | undefined;

  constructor(backend?: CodergenBackend) {
    this._backend = backend;
  }

  async execute(node: GraphNode, context: Context, graph: Graph, logsRoot: string): Promise<Outcome> {
    let prompt = node.attrs.prompt || node.attrs.label || node.id;
    prompt = expandVariables(prompt, graph, context);

    const stageDir = join(logsRoot, node.id);
    await mkdir(stageDir, { recursive: true });
    await writeFile(join(stageDir, "prompt.md"), prompt, "utf-8");

    let responseText: string;
    if (this._backend) {
      try {
        const result = await this._backend.run(node, prompt, context);
        if (typeof result === "object" && "status" in result) {
          await writeStatus(stageDir, result as Outcome);
          return result as Outcome;
        }
        responseText = String(result);
      } catch (err) {
        return { status: "fail", failure_reason: String(err) };
      }
    } else {
      responseText = `[Simulated] Response for stage: ${node.id}`;
    }

    await writeFile(join(stageDir, "response.md"), responseText, "utf-8");

    const outcome: Outcome = {
      status: "success",
      notes: `Stage completed: ${node.id}`,
      context_updates: {
        last_stage: node.id,
        last_response: responseText.slice(0, 200),
      },
    };
    await writeStatus(stageDir, outcome);
    return outcome;
  }
}

// ---------------------------------------------------------------------------
// 4.6 Wait For Human Handler
// ---------------------------------------------------------------------------

export class WaitForHumanHandler implements Handler {
  private _interviewer: Interviewer;

  constructor(interviewer: Interviewer) {
    this._interviewer = interviewer;
  }

  async execute(node: GraphNode, context: Context, graph: Graph): Promise<Outcome> {
    const edges = graph.edges.filter((e) => e.from === node.id);

    if (edges.length === 0) {
      return { status: "fail", failure_reason: "No outgoing edges for human gate" };
    }

    const options: Option[] = edges.map((edge) => {
      const label = edge.attrs.label || edge.to;
      const key = parseAcceleratorKey(label);
      return { key, label };
    });

    const question: Question = {
      text: node.attrs.label || "Select an option:",
      type: "multiple_choice",
      options,
      stage: node.id,
    };

    const answer = await this._interviewer.ask(question);

    if (answer.value === "timeout") {
      return { status: "retry", failure_reason: "human gate timeout" };
    }
    if (answer.value === "skipped") {
      return { status: "fail", failure_reason: "human skipped interaction" };
    }

    // Find matching choice
    const selected = answer.selected_option ?? options.find((o) => o.key === answer.value) ?? options[0];
    const targetEdge = edges.find((e) => (e.attrs.label || e.to) === selected.label);

    return {
      status: "success",
      suggested_next_ids: targetEdge ? [targetEdge.to] : [edges[0].to],
      context_updates: {
        "human.gate.selected": selected.key,
        "human.gate.label": selected.label,
      },
    };
  }
}

function parseAcceleratorKey(label: string): string {
  // [K] Label
  let match = label.match(/^\[(\w)\]\s/);
  if (match) return match[1];
  // K) Label
  match = label.match(/^(\w)\)\s/);
  if (match) return match[1];
  // K - Label
  match = label.match(/^(\w)\s-\s/);
  if (match) return match[1];
  // First character
  return label[0]?.toUpperCase() ?? "";
}

// ---------------------------------------------------------------------------
// 4.7 Conditional Handler
// ---------------------------------------------------------------------------

export class ConditionalHandler implements Handler {
  async execute(node: GraphNode, context: Context): Promise<Outcome> {
    // A conditional (diamond) node is a pass-through gate.
    // It forwards the upstream outcome so edge conditions evaluate
    // against the *previous* node's result, not this node's.
    const upstream = context.get("outcome") as string | undefined;
    const status = (upstream === "fail" || upstream === "retry")
      ? upstream as "fail" | "retry"
      : "success";
    return { status, notes: `Conditional gate: forwarding outcome=${status}` };
  }
}

// ---------------------------------------------------------------------------
// 4.10 Tool Handler
// ---------------------------------------------------------------------------

export class ToolHandler implements Handler {
  async execute(node: GraphNode): Promise<Outcome> {
    const command = node.attrs.tool_command as string | undefined;
    if (!command) {
      return { status: "fail", failure_reason: "No tool_command specified" };
    }

    const { exec } = await import("node:child_process");
    return new Promise((resolve) => {
      exec(command, { timeout: 30_000 }, (error, stdout, stderr) => {
        if (error) {
          resolve({ status: "fail", failure_reason: String(error) });
        } else {
          resolve({
            status: "success",
            context_updates: { "tool.output": stdout },
            notes: `Tool completed: ${command}`,
          });
        }
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Handler Registry
// ---------------------------------------------------------------------------

export class HandlerRegistry {
  private _handlers = new Map<string, Handler>();
  private _defaultHandler: Handler;

  constructor(opts?: { backend?: CodergenBackend; interviewer?: Interviewer }) {
    this._defaultHandler = new CodergenHandler(opts?.backend);

    this.register("start", new StartHandler());
    this.register("exit", new ExitHandler());
    this.register("codergen", this._defaultHandler);
    this.register("conditional", new ConditionalHandler());
    this.register("tool", new ToolHandler());

    if (opts?.interviewer) {
      this.register("wait.human", new WaitForHumanHandler(opts.interviewer));
    }
  }

  register(type: string, handler: Handler): void {
    this._handlers.set(type, handler);
  }

  resolve(node: GraphNode): Handler {
    // 1. Explicit type attribute
    if (node.attrs.type) {
      const h = this._handlers.get(node.attrs.type);
      if (h) return h;
    }

    // 2. Shape-based resolution
    const shape = node.attrs.shape ?? "box";
    const handlerType = SHAPE_TO_TYPE[shape];
    if (handlerType) {
      const h = this._handlers.get(handlerType);
      if (h) return h;
    }

    // 3. Default
    return this._defaultHandler;
  }
}
