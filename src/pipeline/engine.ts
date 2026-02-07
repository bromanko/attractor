/**
 * Pipeline Execution Engine — Section 3 of the Attractor Spec.
 * Core execution loop: traverse the graph, execute handlers, select edges.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Graph, GraphNode, GraphEdge, Outcome, Context as ContextType,
  Checkpoint, PipelineEvent, PipelineEventKind,
  Interviewer, CodergenBackend,
} from "./types.js";
import { Context, SHAPE_TO_TYPE } from "./types.js";
import { HandlerRegistry } from "./handlers.js";
import { evaluateCondition } from "./conditions.js";
import { findStartNode, findExitNodes, validateOrRaise } from "./validator.js";

// ---------------------------------------------------------------------------
// Edge selection algorithm (Section 3.3)
// ---------------------------------------------------------------------------

function normalizeLabel(label: string): string {
  let normalized = label.toLowerCase().trim();
  // Strip accelerator prefixes: [Y] , Y) , Y -
  normalized = normalized.replace(/^\[\w\]\s*/, "");
  normalized = normalized.replace(/^\w\)\s*/, "");
  normalized = normalized.replace(/^\w\s*-\s*/, "");
  return normalized;
}

function bestByWeightThenLexical(edges: GraphEdge[]): GraphEdge | undefined {
  if (edges.length === 0) return undefined;
  return edges.sort((a, b) => {
    const wa = a.attrs.weight ?? 0;
    const wb = b.attrs.weight ?? 0;
    if (wb !== wa) return wb - wa; // Higher weight first
    return a.to.localeCompare(b.to); // Lexical tiebreak
  })[0];
}

function selectEdge(
  node: GraphNode,
  outcome: Outcome,
  context: ContextType,
  graph: Graph,
): GraphEdge | undefined {
  const edges = graph.edges.filter((e) => e.from === node.id);
  if (edges.length === 0) return undefined;

  // Step 1: Condition matching
  const conditionMatched: GraphEdge[] = [];
  for (const edge of edges) {
    if (edge.attrs.condition) {
      if (evaluateCondition(edge.attrs.condition, outcome, context)) {
        conditionMatched.push(edge);
      }
    }
  }
  if (conditionMatched.length > 0) {
    return bestByWeightThenLexical(conditionMatched);
  }

  // Step 2: Preferred label
  if (outcome.preferred_label) {
    const normalized = normalizeLabel(outcome.preferred_label);
    for (const edge of edges) {
      if (edge.attrs.label && normalizeLabel(edge.attrs.label) === normalized) {
        return edge;
      }
    }
  }

  // Step 3: Suggested next IDs
  if (outcome.suggested_next_ids && outcome.suggested_next_ids.length > 0) {
    for (const suggestedId of outcome.suggested_next_ids) {
      const edge = edges.find((e) => e.to === suggestedId);
      if (edge) return edge;
    }
  }

  // Step 4 & 5: Weight with lexical tiebreak (unconditional edges only)
  const unconditional = edges.filter((e) => !e.attrs.condition);
  if (unconditional.length > 0) {
    return bestByWeightThenLexical(unconditional);
  }

  // Fallback: any edge
  return bestByWeightThenLexical(edges);
}

// ---------------------------------------------------------------------------
// Retry policy (Section 3.5-3.6)
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(attempt: number): number {
  const delay = 200 * Math.pow(2, attempt - 1);
  const capped = Math.min(delay, 60_000);
  const jitter = capped * (0.5 + Math.random());
  return jitter;
}

// ---------------------------------------------------------------------------
// Goal gate check (Section 3.4)
// ---------------------------------------------------------------------------

function checkGoalGates(
  graph: Graph,
  nodeOutcomes: Map<string, Outcome>,
): { ok: boolean; failedNode?: GraphNode } {
  for (const [nodeId, outcome] of nodeOutcomes) {
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node?.attrs.goal_gate) continue;
    if (outcome.status !== "success" && outcome.status !== "partial_success") {
      return { ok: false, failedNode: node };
    }
  }
  return { ok: true };
}

function getRetryTarget(node: GraphNode, graph: Graph): string | undefined {
  return (
    node.attrs.retry_target ||
    node.attrs.fallback_retry_target ||
    (graph.attrs.retry_target as string) ||
    (graph.attrs.fallback_retry_target as string) ||
    undefined
  );
}

// ---------------------------------------------------------------------------
// Pipeline runner
// ---------------------------------------------------------------------------

export type PipelineConfig = {
  graph: Graph;
  logsRoot: string;
  backend?: CodergenBackend;
  interviewer?: Interviewer;
  checkpoint?: Checkpoint;
  onEvent?: (event: PipelineEvent) => void;
};

export type PipelineResult = {
  status: "success" | "fail";
  completedNodes: string[];
  lastOutcome?: Outcome;
};

function emit(config: PipelineConfig, kind: PipelineEventKind, data: Record<string, unknown> = {}): void {
  config.onEvent?.({
    kind,
    timestamp: new Date().toISOString(),
    data,
  });
}

/**
 * Run a pipeline from start to finish.
 * Implements the core execution loop (Section 3.2).
 */
export async function runPipeline(config: PipelineConfig): Promise<PipelineResult> {
  const { graph, logsRoot } = config;

  // Validate
  validateOrRaise(graph);

  // Initialize
  const context = new Context();
  if (graph.attrs.goal) context.set("graph.goal", graph.attrs.goal);
  if (graph.attrs.label) context.set("graph.label", graph.attrs.label);

  const registry = new HandlerRegistry({
    backend: config.backend,
    interviewer: config.interviewer,
  });

  const completedNodes: string[] = [];
  const nodeOutcomes = new Map<string, Outcome>();
  const nodeRetries = new Map<string, number>();

  // Resolve start node
  const startId = findStartNode(graph);
  if (!startId) throw new Error("No start node found.");
  const exitIds = new Set(findExitNodes(graph));

  let currentNode = graph.nodes.find((n) => n.id === startId)!;

  // Resume from checkpoint
  const cp = config.checkpoint;
  if (cp) {
    completedNodes.push(...cp.completed_nodes);
    context.applyUpdates(cp.context_values);
    for (const [id, count] of Object.entries(cp.node_retries)) {
      nodeRetries.set(id, count);
    }
    const resumeNode = graph.nodes.find((n) => n.id === cp.current_node);
    if (resumeNode) {
      const lastEdge = graph.edges.find((e) => e.from === cp.current_node);
      if (lastEdge) {
        currentNode = graph.nodes.find((n) => n.id === lastEdge.to) ?? currentNode;
      }
    }
  }

  await mkdir(logsRoot, { recursive: true });
  emit(config, "pipeline_started", { name: graph.name });

  // Main execution loop
  while (true) {
    const node = currentNode;

    // Check for terminal node
    if (exitIds.has(node.id)) {
      // Execute exit handler
      const handler = registry.resolve(node);
      await handler.execute(node, context, graph, logsRoot);
      completedNodes.push(node.id);

      // Goal gate check (Section 3.4)
      const { ok, failedNode } = checkGoalGates(graph, nodeOutcomes);
      if (!ok && failedNode) {
        const retryTarget = getRetryTarget(failedNode, graph);
        if (retryTarget) {
          const targetNode = graph.nodes.find((n) => n.id === retryTarget);
          if (targetNode) {
            currentNode = targetNode;
            continue;
          }
        }
        emit(config, "pipeline_failed", { error: `Goal gate unsatisfied: ${failedNode.id}` });
        return { status: "fail", completedNodes, lastOutcome: nodeOutcomes.get(failedNode.id) };
      }

      emit(config, "pipeline_completed", { duration: 0 });
      return { status: "success", completedNodes };
    }

    // Execute node handler with retry
    const handler = registry.resolve(node);
    const maxRetries = node.attrs.max_retries ?? (graph.attrs.default_max_retry as number) ?? 0;
    const maxAttempts = maxRetries + 1;
    let outcome: Outcome | undefined;

    emit(config, "stage_started", { name: node.id, index: completedNodes.length });

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        outcome = await handler.execute(node, context, graph, logsRoot);
      } catch (err) {
        outcome = { status: "fail", failure_reason: String(err) };
      }

      if (outcome.status === "success" || outcome.status === "partial_success") {
        nodeRetries.delete(node.id);
        break;
      }

      if (outcome.status === "retry" && attempt < maxAttempts) {
        const count = (nodeRetries.get(node.id) ?? 0) + 1;
        nodeRetries.set(node.id, count);
        emit(config, "stage_retrying", { name: node.id, attempt, delay: retryDelay(attempt) });
        await sleep(retryDelay(attempt));
        continue;
      }

      if (outcome.status === "fail") {
        if (attempt < maxAttempts) {
          const count = (nodeRetries.get(node.id) ?? 0) + 1;
          nodeRetries.set(node.id, count);
          emit(config, "stage_retrying", { name: node.id, attempt, delay: retryDelay(attempt) });
          await sleep(retryDelay(attempt));
          continue;
        }
        // Retries exhausted
        if (node.attrs.allow_partial) {
          outcome = { status: "partial_success", notes: "retries exhausted, partial accepted" };
        }
        break;
      }

      break;
    }

    if (!outcome) {
      outcome = { status: "fail", failure_reason: "No outcome produced" };
    }

    completedNodes.push(node.id);
    nodeOutcomes.set(node.id, outcome);

    // Apply context updates
    if (outcome.context_updates) {
      context.applyUpdates(outcome.context_updates);
    }
    context.set("outcome", outcome.status);
    if (outcome.preferred_label) {
      context.set("preferred_label", outcome.preferred_label);
    }

    if (outcome.status === "success" || outcome.status === "partial_success") {
      emit(config, "stage_completed", { name: node.id, index: completedNodes.length - 1 });
    } else {
      emit(config, "stage_failed", { name: node.id, error: outcome.failure_reason });
    }

    // Save checkpoint
    const checkpoint: Checkpoint = {
      timestamp: new Date().toISOString(),
      current_node: node.id,
      completed_nodes: [...completedNodes],
      node_retries: Object.fromEntries(nodeRetries),
      context_values: context.snapshot(),
      logs: [...context.logs],
    };
    await writeFile(join(logsRoot, "checkpoint.json"), JSON.stringify(checkpoint, null, 2), "utf-8");
    emit(config, "checkpoint_saved", { node_id: node.id });

    // Select next edge (Section 3.3)
    const nextEdge = selectEdge(node, outcome, context, graph);

    if (!nextEdge) {
      if (outcome.status === "fail") {
        // Check for retry_target (Section 3.7)
        const retryTarget = node.attrs.retry_target || node.attrs.fallback_retry_target;
        if (retryTarget) {
          const targetNode = graph.nodes.find((n) => n.id === retryTarget);
          if (targetNode) {
            currentNode = targetNode;
            continue;
          }
        }
        emit(config, "pipeline_failed", { error: `Stage failed with no outgoing edge: ${node.id}` });
        return { status: "fail", completedNodes, lastOutcome: outcome };
      }
      // No edge and not failed — pipeline ends
      break;
    }

    // Handle loop_restart (Section 3.2 step 7)
    if (nextEdge.attrs.loop_restart) {
      // Restart would create a fresh run — for now just continue to target
    }

    // Advance
    const nextNode = graph.nodes.find((n) => n.id === nextEdge.to);
    if (!nextNode) {
      emit(config, "pipeline_failed", { error: `Edge target "${nextEdge.to}" not found` });
      return { status: "fail", completedNodes, lastOutcome: outcome };
    }

    currentNode = nextNode;
  }

  const lastOutcome = completedNodes.length > 0
    ? nodeOutcomes.get(completedNodes[completedNodes.length - 1])
    : undefined;

  emit(config, "pipeline_completed", { duration: 0 });
  return { status: "success", completedNodes, lastOutcome };
}
