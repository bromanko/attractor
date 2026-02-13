import { extname } from "node:path";
import type { Graph, GraphNode, GraphEdge } from "./types.js";
import type { Awf2Workflow, Awf2Stage, Awf2Transition } from "./awf2-types.js";
import { parseAwf2Kdl } from "./awf2-kdl-parser.js";
import { validateAwf2OrRaise } from "./awf2-validator.js";
import { compileAwf2ExprToEngineConditions, type EngineConditions } from "./awf2-expr.js";

export type LoadedWorkflow = {
  format: "dot" | "awf2";
  graph: Graph;
  awf2?: Awf2Workflow;
};

function encodeOrderWeight(priority: number | undefined, index: number, total: number): number {
  const p = priority ?? 0;
  return p * 1_000_000 + (total - index);
}

function toEdgeConditions(expr: string | undefined): Array<string | undefined> {
  if (!expr) return [undefined];
  const trimmed = expr.trim();
  if (!trimmed || trimmed === "true") return [undefined];
  const result: EngineConditions = compileAwf2ExprToEngineConditions(trimmed);
  switch (result.kind) {
    case "unsatisfiable":
      return [];
    case "unconditional":
      return [undefined];
    case "disjunction":
      return result.clauses;
  }
}

function stageToGraphNode(stage: Awf2Stage): GraphNode {
  const attrs: Record<string, unknown> = {};

  if (stage.kind === "llm") {
    attrs.shape = "box";
    if (stage.prompt) attrs.prompt = stage.prompt;
    if (stage.prompt_file) attrs.prompt_file = stage.prompt_file;
    if (stage.model) attrs.llm_model = stage.model;
    if (stage.provider) attrs.llm_provider = stage.provider;
    if (stage.reasoning_effort) attrs.reasoning_effort = stage.reasoning_effort;
    if (stage.auto_status != null) attrs.auto_status = stage.auto_status;
    if (stage.goal_gate != null) attrs.goal_gate = stage.goal_gate;
    if (stage.response_key_base) attrs.response_key_base = stage.response_key_base;
  } else if (stage.kind === "tool") {
    attrs.shape = "parallelogram";
    attrs.tool_command = stage.command;
    if (stage.timeout) attrs.timeout = stage.timeout;
  } else if (stage.kind === "human") {
    attrs.shape = "hexagon";
    attrs.prompt = stage.prompt;
    if (stage.re_review != null) attrs.re_review = stage.re_review;
  } else if (stage.kind === "decision") {
    attrs.shape = "diamond";
  } else if (stage.kind === "exit") {
    attrs.shape = "Msquare";
  } else {
    // workspace.*
    attrs.shape = "box";
    attrs.type = stage.kind;
    if (stage.workspace_name) attrs.workspace_name = stage.workspace_name;
  }

  if (stage.retry) {
    attrs.max_retries = Math.max(0, stage.retry.max_attempts - 1);
  }

  return { id: stage.id, attrs };
}

function addTransitionEdges(edges: GraphEdge[], transitions: Awf2Transition[]): void {
  const bySource = new Map<string, Awf2Transition[]>();
  for (const t of transitions) {
    const list = bySource.get(t.from) ?? [];
    list.push(t);
    bySource.set(t.from, list);
  }

  for (const [from, list] of bySource.entries()) {
    for (let i = 0; i < list.length; i++) {
      const t = list[i]!;
      const conditions = toEdgeConditions(t.when);
      for (const condition of conditions) {
        edges.push({
          from,
          to: t.to,
          attrs: {
            condition,
            weight: encodeOrderWeight(t.priority, i, list.length),
          },
        });
      }
    }
  }
}

export function awf2ToGraph(workflow: Awf2Workflow): Graph {
  const startNodeId = "__start__";

  const nodes: GraphNode[] = [
    { id: startNodeId, attrs: { shape: "Mdiamond", label: "Start" } },
    ...workflow.stages.map(stageToGraphNode),
  ];

  const edges: GraphEdge[] = [
    { from: startNodeId, to: workflow.start, attrs: {} },
  ];

  addTransitionEdges(edges, workflow.transitions ?? []);

  // Stage-local routing
  for (const stage of workflow.stages) {
    if (stage.kind === "human") {
      for (const option of stage.options) {
        edges.push({
          from: stage.id,
          to: option.to,
          attrs: { label: option.label },
        });
      }
    }

    if (stage.kind === "decision") {
      for (let i = 0; i < stage.routes.length; i++) {
        const route = stage.routes[i]!;
        const conditions = toEdgeConditions(route.when);
        for (const condition of conditions) {
          edges.push({
            from: stage.id,
            to: route.to,
            attrs: {
              condition,
              weight: encodeOrderWeight(route.priority, i, stage.routes.length),
            },
          });
        }
      }
    }
  }

  return {
    name: workflow.name,
    attrs: {
      goal: workflow.goal,
      label: workflow.name,
    },
    nodes,
    edges,
    node_defaults: {},
    edge_defaults: {},
  };
}

export function parseAwf2Workflow(source: string): Awf2Workflow {
  const workflow = parseAwf2Kdl(source);
  validateAwf2OrRaise(workflow);
  return workflow;
}

export function parseWorkflowToGraph(source: string, filePath?: string): LoadedWorkflow {
  const ext = filePath ? extname(filePath).toLowerCase() : "";

  if (ext === ".kdl") {
    const awf2 = parseAwf2Workflow(source);
    return { format: "awf2", graph: awf2ToGraph(awf2), awf2 };
  }

  // dot parsing is still handled by existing call sites for now.
  throw new Error("parseWorkflowToGraph currently supports only .kdl paths. Use parseDot for .dot workflows.");
}
