/**
 * Pipeline Execution Engine — Section 3 of the Attractor Spec.
 * Core execution loop: traverse the graph, execute handlers, select edges.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import type {
  Graph, GraphNode, GraphEdge, Outcome, Context as ContextType,
  Checkpoint, PipelineEvent, PipelineEventKind,
  Interviewer, CodergenBackend,
  UsageMetrics, StageAttemptUsage, RunUsageSummary, UsageUpdatePayload,
} from "./types.js";
import { Context, SHAPE_TO_TYPE } from "./types.js";
import { HandlerRegistry } from "./handlers.js";
import { evaluateCondition } from "./conditions.js";
import { findStartNode, findExitNodes, validateOrRaise } from "./validator.js";
import { emergencyWorkspaceCleanup } from "./workspace.js";
import type { JjRunner } from "./workspace.js";

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

/**
 * Like selectEdge but restricts which edges are followed on failure.
 * Allows:
 *  1. Edges with conditions that match (explicit failure handling)
 *  2. Edges whose target is a conditional/routing gate (diamond) — the gate
 *     is designed to route based on the outcome, so forwarding fail is correct
 *     (e.g. plan_review → plan_gate)
 *  3. Edges suggested by the handler via suggested_next_ids
 *
 * Does NOT allow unconditional edges to regular execution nodes — that would
 * silently swallow errors (e.g. ws_create failing then continuing to plan).
 */
function selectFailureEdge(
  node: GraphNode,
  outcome: Outcome,
  context: ContextType,
  graph: Graph,
): GraphEdge | undefined {
  const edges = graph.edges.filter((e) => e.from === node.id);
  if (edges.length === 0) return undefined;

  // 1. Edges with conditions that match
  for (const edge of edges) {
    if (edge.attrs.condition && evaluateCondition(edge.attrs.condition, outcome, context)) {
      return edge;
    }
  }

  // 2. Unconditional edges to conditional/routing gates
  for (const edge of edges) {
    if (!edge.attrs.condition) {
      const targetNode = graph.nodes.find((n) => n.id === edge.to);
      if (targetNode && (targetNode.attrs.shape === "diamond" || targetNode.attrs.type === "conditional")) {
        return edge;
      }
    }
  }

  // 3. Handler-suggested targets
  if (outcome.suggested_next_ids && outcome.suggested_next_ids.length > 0) {
    for (const suggestedId of outcome.suggested_next_ids) {
      const edge = edges.find((e) => e.to === suggestedId);
      if (edge) return edge;
    }
  }

  return undefined;
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal!.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
  /**
   * If true, automatically clean up any jj workspace created during this
   * pipeline run when the pipeline fails. Defaults to true.
   */
  cleanupWorkspaceOnFailure?: boolean;
  /** Custom jj runner for workspace operations (useful for testing). */
  jjRunner?: JjRunner;
  /** Abort signal for cooperative cancellation. */
  abortSignal?: AbortSignal;
};

/** Summary of the first stage failure in a failed pipeline. */
export type PipelineFailureSummary = {
  failedNode: string;
  failureClass: string;
  digest: string;
  firstFailingCheck?: string;
  rerunCommand?: string;
  logsPath?: string;
  /** Failure reason from the handler (available for LLM/codergen failures). */
  failureReason?: string;
};

export type PipelineResult = {
  status: "success" | "fail" | "cancelled";
  completedNodes: string[];
  lastOutcome?: Outcome;
  /** Present when status is "fail" and a stage produced failure details. */
  failureSummary?: PipelineFailureSummary;
  /** Usage summary for this invocation (always present). */
  usageSummary: RunUsageSummary;
};

// ---------------------------------------------------------------------------
// Usage helpers
// ---------------------------------------------------------------------------

function emptyMetrics(): UsageMetrics {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 0, cost: 0 };
}

/** Safely parse a numeric usage value from context, returning 0 for invalid/missing. */
function safeNum(val: unknown): number {
  if (val == null) return 0;
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

/** Extract UsageMetrics from context_updates for a given node ID.
 *  Uses the outcome's context_updates (not the shared context) so each
 *  attempt only contributes its own values — avoids double-counting when
 *  retries reuse the same context keys. */
function extractUsageFromUpdates(updates: Record<string, unknown> | undefined, nodeId: string): UsageMetrics {
  if (!updates) return emptyMetrics();
  return {
    input_tokens: safeNum(updates[`${nodeId}.usage.input_tokens`]),
    output_tokens: safeNum(updates[`${nodeId}.usage.output_tokens`]),
    cache_read_tokens: safeNum(updates[`${nodeId}.usage.cache_read_tokens`]),
    cache_write_tokens: safeNum(updates[`${nodeId}.usage.cache_write_tokens`]),
    total_tokens: safeNum(updates[`${nodeId}.usage.total_tokens`]),
    cost: safeNum(updates[`${nodeId}.usage.cost`]),
  };
}

/** Add metrics b onto metrics a (mutates a). */
function addMetrics(a: UsageMetrics, b: UsageMetrics): void {
  a.input_tokens += b.input_tokens;
  a.output_tokens += b.output_tokens;
  a.cache_read_tokens += b.cache_read_tokens;
  a.cache_write_tokens += b.cache_write_tokens;
  a.total_tokens += b.total_tokens;
  a.cost += b.cost;
}

/** Check if metrics has any non-zero value. */
function hasUsage(m: UsageMetrics): boolean {
  return m.input_tokens > 0 || m.output_tokens > 0 || m.cache_read_tokens > 0 || m.cache_write_tokens > 0 || m.total_tokens > 0 || m.cost > 0;
}

/** Build a RunUsageSummary from collected stage attempts. Always returns a
 *  summary (possibly with empty stages and zero totals) for stable rendering. */
function buildUsageSummary(attempts: StageAttemptUsage[]): RunUsageSummary {
  const totals = emptyMetrics();
  for (const a of attempts) {
    addMetrics(totals, a.metrics);
  }
  return { stages: [...attempts], totals };
}

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

  // Force non-interactive editors for all subprocesses.
  // LLM agents may run jj/git commands that open an editor (e.g. jj squash),
  // which would hang since stdin is not a TTY. Using `true` as the editor
  // makes these commands succeed with the default message.
  process.env.JJ_EDITOR ??= "true";
  process.env.GIT_EDITOR ??= "true";

  // Validate
  validateOrRaise(graph);

  // Initialize
  const context = new Context();
  if (graph.attrs.goal) context.set("graph.goal", graph.attrs.goal);
  if (graph.attrs.label) context.set("graph.label", graph.attrs.label);

  const abortSignal = config.abortSignal;

  const registry = new HandlerRegistry({
    backend: config.backend,
    interviewer: config.interviewer,
    jjRunner: config.jjRunner,
    abortSignal,
  });

  const completedNodes: string[] = [];
  const nodeOutcomes = new Map<string, Outcome>();
  const nodeRetries = new Map<string, number>();
  const usageAttempts: StageAttemptUsage[] = [];

  // Resolve start node
  const startId = findStartNode(graph);
  if (!startId) throw new Error("No start node found.");
  const exitIds = new Set(findExitNodes(graph));

  let currentNode = graph.nodes.find((n) => n.id === startId)!;

  // Resume from checkpoint
  const cp = config.checkpoint;
  if (cp) {
    // Restore context and retry counts
    context.applyUpdates(cp.context_values);
    for (const [id, count] of Object.entries(cp.node_retries)) {
      nodeRetries.set(id, count);
    }

    // Resume at the node specified by resume_at (if set), otherwise re-run
    // the last completed node (which was the one that failed).
    const resumeId = cp.resume_at ?? cp.current_node;
    const resumeNode = graph.nodes.find((n) => n.id === resumeId);
    if (resumeNode) {
      currentNode = resumeNode;
      // Mark everything before the resume node as completed (but not the
      // resume node itself — it will be re-executed).
      const idx = cp.completed_nodes.indexOf(resumeId);
      const alreadyDone = idx >= 0
        ? cp.completed_nodes.slice(0, idx)
        : cp.completed_nodes;
      completedNodes.push(...alreadyDone);
    }

    // Recover workspace if it was cleaned up on the previous failure
    const wsPath = context.getString("workspace.path");
    const wsName = context.getString("workspace.name");
    if (wsPath && wsName && !existsSync(wsPath)) {
      try {
        const quietExec = async (args: string[], cwd?: string) => {
          if (config.jjRunner) return config.jjRunner(args);
          const { execFileSync } = await import("node:child_process");
          return execFileSync("jj", args, {
            encoding: "utf-8",
            cwd: cwd ?? undefined,
            stdio: ["pipe", "pipe", "pipe"],
          }).trim();
        };

        // Forget the old workspace registration if it still exists in jj
        try { await quietExec(["workspace", "forget", wsName]); } catch { /* ignore */ }

        await quietExec(["workspace", "add", "--name", wsName, wsPath]);

        // Restore to the tip commit from before the failure
        const tipCommit = context.getString("workspace.tip_commit");
        if (tipCommit) {
          await quietExec(["edit", tipCommit], wsPath);
          emit(config, "stage_completed", { name: `ws_recover(${wsName}@${tipCommit})` });
        } else {
          emit(config, "stage_completed", { name: `ws_recover(${wsName})` });
        }
      } catch (err) {
        emit(config, "pipeline_failed", { error: `Failed to recover workspace "${wsName}": ${err}` });
        return { status: "fail", completedNodes, lastOutcome: { status: "fail", failure_reason: String(err) }, usageSummary: buildUsageSummary(usageAttempts) };
      }
    }

    emit(config, "pipeline_resumed", { from: currentNode.id, nodeCount: graph.nodes.length });
  }

  await mkdir(logsRoot, { recursive: true });
  emit(config, "pipeline_started", { name: graph.name, nodeCount: graph.nodes.length });

  const shouldCleanupWorkspace = config.cleanupWorkspaceOnFailure !== false;

  // Helper: build a PipelineFailureSummary from the first failed stage.
  // Handles tool stages (structured tool_failure) and LLM/codergen stages
  // (failure_reason only) so both get actionable summaries.
  function buildFailureSummary(
    failedNodeId: string,
    outcome: Outcome | undefined,
  ): PipelineFailureSummary | undefined {
    if (!outcome || outcome.status === "success") return undefined;

    // Tool stage failures have rich structured data
    if (outcome.tool_failure) {
      const tf = outcome.tool_failure;
      return {
        failedNode: failedNodeId,
        failureClass: tf.failureClass,
        digest: tf.digest,
        firstFailingCheck: tf.firstFailingCheck,
        rerunCommand: tf.command,
        logsPath: tf.artifactPaths.meta ? dirname(tf.artifactPaths.meta) : undefined,
      };
    }

    // Non-tool failures (LLM errors, backend failures, etc.)
    const reason = outcome.failure_reason ?? "Unknown failure";
    const failedNode = graph.nodes.find((n) => n.id === failedNodeId);
    const nodeType = failedNode?.attrs.type ?? failedNode?.attrs.shape ?? "unknown";
    const isLlm = nodeType === "box" || nodeType === "codergen";
    const failureClass = isLlm ? "llm_error" : "stage_error";
    const nodeLogsPath = join(logsRoot, failedNodeId);

    return {
      failedNode: failedNodeId,
      failureClass,
      digest: reason.length > 200 ? reason.slice(0, 200) + "…" : reason,
      logsPath: nodeLogsPath,
      failureReason: reason,
    };
  }

  // Helper: clean up workspace on failure if one was created
  async function cleanupOnFailure(result: Omit<PipelineResult, "usageSummary">): Promise<PipelineResult> {
    if (result.status === "fail" && shouldCleanupWorkspace) {
      await emergencyWorkspaceCleanup(context, config.jjRunner);
    }
    return { ...result, usageSummary: buildUsageSummary(usageAttempts) };
  }

  // Helper: check if cancelled and save checkpoint + emit event
  async function checkCancelled(
    currentNodeId: string,
  ): Promise<PipelineResult | null> {
    if (!abortSignal?.aborted) return null;

    // Save checkpoint for resume
    const checkpoint: Checkpoint = {
      timestamp: new Date().toISOString(),
      current_node: currentNodeId,
      completed_nodes: [...completedNodes],
      node_retries: Object.fromEntries(nodeRetries),
      context_values: context.snapshot(),
      logs: [...context.logs],
    };
    await writeFile(join(logsRoot, "checkpoint.json"), JSON.stringify(checkpoint, null, 2), "utf-8");
    emit(config, "checkpoint_saved", { node_id: currentNodeId });
    emit(config, "pipeline_cancelled", { reason: "aborted", node_id: currentNodeId });

    return {
      status: "cancelled",
      completedNodes,
      lastOutcome: { status: "cancelled", failure_reason: "Pipeline cancelled" },
      usageSummary: buildUsageSummary(usageAttempts),
    };
  }

  // Main execution loop
  while (true) {
    // Check for cancellation before executing next stage
    const cancelResult = await checkCancelled(currentNode.id);
    if (cancelResult) return cancelResult;

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
        const goalOutcome = nodeOutcomes.get(failedNode.id);
        return cleanupOnFailure({
          status: "fail", completedNodes, lastOutcome: goalOutcome,
          failureSummary: buildFailureSummary(failedNode.id, goalOutcome),
        });
      }

      emit(config, "pipeline_completed", { duration: 0 });
      return { status: "success", completedNodes, usageSummary: buildUsageSummary(usageAttempts) };
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
        // Check if this was a cancellation
        if (abortSignal?.aborted) {
          const cr = await checkCancelled(node.id);
          if (cr) return cr;
        }
        outcome = { status: "fail", failure_reason: String(err) };
      }

      // Apply context updates early so usage is captured before cancellation check
      if (outcome.context_updates) {
        context.applyUpdates(outcome.context_updates);
      }

      // Extract usage for this attempt from the outcome's own context_updates
      // (not the shared context) so retries don't double-count stale values.
      {
        const attemptUsage = extractUsageFromUpdates(outcome.context_updates, node.id);
        if (hasUsage(attemptUsage)) {
          const attemptIdx = (nodeRetries.get(node.id) ?? 0) + 1;
          usageAttempts.push({ stageId: node.id, attempt: attemptIdx, metrics: attemptUsage });
        }
      }

      // Check for cancellation after stage completion
      if (abortSignal?.aborted) {
        const cr = await checkCancelled(node.id);
        if (cr) return cr;
      }

      if (outcome.status === "success" || outcome.status === "partial_success") {
        nodeRetries.delete(node.id);
        break;
      }

      if (outcome.status === "retry" && attempt < maxAttempts) {
        const count = (nodeRetries.get(node.id) ?? 0) + 1;
        nodeRetries.set(node.id, count);
        const delay1 = retryDelay(attempt);
        emit(config, "stage_retrying", { name: node.id, attempt, delay: delay1 });
        try {
          await sleep(delay1, abortSignal);
        } catch {
          // Abort during backoff — exit immediately
          const cr = await checkCancelled(node.id);
          if (cr) return cr;
        }
        continue;
      }

      if (outcome.status === "fail") {
        if (attempt < maxAttempts) {
          const count = (nodeRetries.get(node.id) ?? 0) + 1;
          nodeRetries.set(node.id, count);
          const delay2 = retryDelay(attempt);
          emit(config, "stage_retrying", { name: node.id, attempt, delay: delay2 });
          try {
            await sleep(delay2, abortSignal);
          } catch {
            // Abort during backoff — exit immediately
            const cr = await checkCancelled(node.id);
            if (cr) return cr;
          }
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

    // Context updates already applied in retry loop above
    context.set("outcome", outcome.status);
    if (outcome.preferred_label) {
      context.set("preferred_label", outcome.preferred_label);
    }

    // Emit usage_update event for any usage collected in this stage
    // (usage was already extracted and accumulated in the retry loop above)
    {
      const lastUsage = usageAttempts.length > 0 ? usageAttempts[usageAttempts.length - 1] : undefined;
      if (lastUsage && lastUsage.stageId === node.id) {
        emit(config, "usage_update", {
          stageId: lastUsage.stageId,
          attempt: lastUsage.attempt,
          metrics: lastUsage.metrics,
          summary: buildUsageSummary(usageAttempts),
        });
      }
    }

    // Conditional (diamond) nodes are routing gates — they forward the upstream
    // outcome for edge selection but don't fail themselves. Always show completed.
    const isConditional =
      node.attrs.shape === "diamond" || node.attrs.type === "conditional";

    if (isConditional || outcome.status === "success" || outcome.status === "partial_success") {
      const completedData: Record<string, unknown> = {
        name: node.id,
        index: completedNodes.length - 1,
      };
      if (outcome.notes) completedData.notes = outcome.notes;
      // Include stage output for rendering: tool stdout or LLM response
      if (outcome.context_updates) {
        const toolOutput = outcome.context_updates["tool.output"];
        if (typeof toolOutput === "string" && toolOutput.trim()) {
          completedData.output = toolOutput;
        } else {
          // LLM stages store response under ${nodeId}.response
          const llmResponse = outcome.context_updates[`${node.id}.response`];
          if (typeof llmResponse === "string" && llmResponse.trim()) {
            completedData.output = llmResponse;
          }
        }
      }
      emit(config, "stage_completed", completedData);
    } else {
      const stageFailedData: Record<string, unknown> = {
        name: node.id,
        error: outcome.failure_reason,
        logsPath: join(logsRoot, node.id),
      };
      if (outcome.tool_failure) {
        stageFailedData.tool_failure = outcome.tool_failure;
      }
      emit(config, "stage_failed", stageFailedData);
    }

    // Capture workspace tip commit for checkpoint recovery
    const wsPathForTip = context.getString("workspace.path");
    if (wsPathForTip && existsSync(wsPathForTip)) {
      try {
        const tipJj = config.jjRunner ?? (async (args: string[]) => {
          const { execFileSync } = await import("node:child_process");
          return execFileSync("jj", args, {
            cwd: wsPathForTip,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          }).trim();
        });
        const tip = await tipJj(["log", "-r", "@", "--no-graph", "-T", "commit_id.short(8)", "--limit", "1"]);
        context.set("workspace.tip_commit", tip);
      } catch {
        // Non-fatal — just means we can't restore the exact commit on resume
      }
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

    // Check for cancellation before scheduling next stage
    {
      const cr = await checkCancelled(node.id);
      if (cr) return cr;
    }

    // Select next edge (Section 3.3)
    // On failure, non-routing nodes should only continue if there's an
    // explicit failure-handling edge (condition match, or unconditional edge
    // leading to a conditional/routing gate that will handle the outcome).
    // Unconditional edges to regular execution nodes should NOT be followed
    // on failure — that would silently swallow errors like workspace creation
    // failures.
    const isFailed = outcome.status === "fail" || outcome.status === "retry";
    const nextEdge = isFailed && !isConditional
      ? selectFailureEdge(node, outcome, context, graph)
      : selectEdge(node, outcome, context, graph);

    if (!nextEdge) {
      if (isFailed) {
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
        return cleanupOnFailure({
          status: "fail", completedNodes, lastOutcome: outcome,
          failureSummary: buildFailureSummary(node.id, outcome),
        });
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
      return cleanupOnFailure({
        status: "fail", completedNodes, lastOutcome: outcome,
        failureSummary: buildFailureSummary(node.id, outcome),
      });
    }

    currentNode = nextNode;
  }

  const lastOutcome = completedNodes.length > 0
    ? nodeOutcomes.get(completedNodes[completedNodes.length - 1])
    : undefined;

  emit(config, "pipeline_completed", { duration: 0 });
  return { status: "success", completedNodes, lastOutcome, usageSummary: buildUsageSummary(usageAttempts) };
}
