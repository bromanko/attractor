/**
 * Validation and Linting — Section 7 of the Attractor Spec.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { Graph, Diagnostic, Severity } from "./types.js";
import { SHAPE_TO_TYPE, KNOWN_HANDLER_TYPES } from "./types.js";
import { parseCondition } from "./conditions.js";

function diag(
  rule: string,
  severity: Severity,
  message: string,
  opts?: { node_id?: string; edge?: [string, string]; fix?: string },
): Diagnostic {
  return { rule, severity, message, ...opts };
}

function findStartNode(graph: Graph): string | undefined {
  const byShape = graph.nodes.find((n) => n.attrs.shape === "Mdiamond");
  if (byShape) return byShape.id;
  return graph.nodes.find((n) => n.id === "start" || n.id === "Start")?.id;
}

function findExitNodes(graph: Graph): string[] {
  const byShape = graph.nodes.filter((n) => n.attrs.shape === "Msquare");
  if (byShape.length > 0) return byShape.map((n) => n.id);
  const byId = graph.nodes.filter((n) => n.id === "exit" || n.id === "end" || n.id === "Exit" || n.id === "End");
  return byId.map((n) => n.id);
}

/**
 * Run all built-in lint rules. Returns a list of diagnostics.
 */
export function validate(graph: Graph): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const nodeIds = new Set(graph.nodes.map((n) => n.id));

  // start_node: exactly one start node
  const startNode = findStartNode(graph);
  const startNodes = graph.nodes.filter((n) => n.attrs.shape === "Mdiamond");
  if (startNodes.length === 0 && !startNode) {
    diagnostics.push(diag("start_node", "error", "Pipeline must have exactly one start node (shape=Mdiamond).", {
      fix: "Add a node with shape=Mdiamond",
    }));
  } else if (startNodes.length > 1) {
    diagnostics.push(diag("start_node", "error", `Pipeline has ${startNodes.length} start nodes; exactly one is required.`));
  }

  // terminal_node: at least one exit node
  const exitNodes = findExitNodes(graph);
  if (exitNodes.length === 0) {
    diagnostics.push(diag("terminal_node", "error", "Pipeline must have at least one exit node (shape=Msquare).", {
      fix: "Add a node with shape=Msquare",
    }));
  }

  // start_no_incoming
  if (startNode) {
    const incoming = graph.edges.filter((e) => e.to === startNode);
    if (incoming.length > 0) {
      diagnostics.push(diag("start_no_incoming", "error", `Start node "${startNode}" has ${incoming.length} incoming edge(s).`, {
        node_id: startNode,
        fix: "Remove incoming edges from the start node",
      }));
    }
  }

  // exit_no_outgoing
  for (const exitId of exitNodes) {
    const outgoing = graph.edges.filter((e) => e.from === exitId);
    if (outgoing.length > 0) {
      diagnostics.push(diag("exit_no_outgoing", "error", `Exit node "${exitId}" has ${outgoing.length} outgoing edge(s).`, {
        node_id: exitId,
        fix: "Remove outgoing edges from the exit node",
      }));
    }
  }

  // edge_target_exists
  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.from)) {
      diagnostics.push(diag("edge_target_exists", "error", `Edge source "${edge.from}" does not exist.`, {
        edge: [edge.from, edge.to],
      }));
    }
    if (!nodeIds.has(edge.to)) {
      diagnostics.push(diag("edge_target_exists", "error", `Edge target "${edge.to}" does not exist.`, {
        edge: [edge.from, edge.to],
      }));
    }
  }

  // reachability: all nodes must be reachable from start
  if (startNode) {
    const reachable = new Set<string>();
    const queue = [startNode];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (reachable.has(current)) continue;
      reachable.add(current);
      for (const edge of graph.edges) {
        if (edge.from === current && !reachable.has(edge.to)) {
          queue.push(edge.to);
        }
      }
    }
    for (const node of graph.nodes) {
      if (!reachable.has(node.id)) {
        diagnostics.push(diag("reachability", "error", `Node "${node.id}" is not reachable from the start node.`, {
          node_id: node.id,
        }));
      }
    }
  }

  // condition_syntax
  for (const edge of graph.edges) {
    if (edge.attrs.condition) {
      try {
        parseCondition(edge.attrs.condition);
      } catch (err) {
        diagnostics.push(diag("condition_syntax", "error", `Invalid condition on edge ${edge.from} -> ${edge.to}: ${err}`, {
          edge: [edge.from, edge.to],
        }));
      }
    }
  }

  // type_known
  for (const node of graph.nodes) {
    if (node.attrs.type) {
      if (!KNOWN_HANDLER_TYPES.has(node.attrs.type)) {
        diagnostics.push(diag("type_known", "warning", `Node "${node.id}" has unknown type "${node.attrs.type}".`, {
          node_id: node.id,
        }));
      }
    }
  }

  // fidelity_valid
  const validFidelities = ["full", "truncate", "compact", "summary:low", "summary:medium", "summary:high"];
  for (const node of graph.nodes) {
    if (node.attrs.fidelity && !validFidelities.includes(node.attrs.fidelity)) {
      diagnostics.push(diag("fidelity_valid", "warning", `Node "${node.id}" has invalid fidelity "${node.attrs.fidelity}".`, {
        node_id: node.id,
      }));
    }
  }

  // retry_target_exists
  for (const node of graph.nodes) {
    if (node.attrs.retry_target && !nodeIds.has(node.attrs.retry_target)) {
      diagnostics.push(diag("retry_target_exists", "warning", `Node "${node.id}" retry_target "${node.attrs.retry_target}" does not exist.`, {
        node_id: node.id,
      }));
    }
    if (node.attrs.fallback_retry_target && !nodeIds.has(node.attrs.fallback_retry_target)) {
      diagnostics.push(diag("retry_target_exists", "warning", `Node "${node.id}" fallback_retry_target "${node.attrs.fallback_retry_target}" does not exist.`, {
        node_id: node.id,
      }));
    }
  }

  // goal_gate_has_retry
  for (const node of graph.nodes) {
    if (node.attrs.goal_gate && !node.attrs.retry_target && !node.attrs.fallback_retry_target) {
      diagnostics.push(diag("goal_gate_has_retry", "warning",
        `Node "${node.id}" has goal_gate=true but no retry_target or fallback_retry_target.`,
        { node_id: node.id },
      ));
    }
  }

  // failure_path: nodes that can fail catastrophically (workspace, CI, tool
  // commands) should have a failure path — either a condition-based edge for
  // outcome!=success, or an unconditional edge to a conditional gate (diamond).
  // LLM/codergen nodes are excluded because their "fail" is typically a
  // deliberate signal (e.g. [STATUS: fail] from a review) not a crash.
  const routingShapes = new Set(["diamond", "Mdiamond", "Msquare", "hexagon"]);
  const infraTypes = new Set(["workspace.create", "workspace.merge", "workspace.cleanup", "selfci"]);
  for (const node of graph.nodes) {
    const shape = node.attrs.shape ?? "box";
    if (routingShapes.has(shape)) continue;

    // Only flag infrastructure/tool nodes, not LLM nodes
    const handlerType = node.attrs.type || SHAPE_TO_TYPE[shape] || "codergen";
    const isInfra = infraTypes.has(handlerType)
      || node.attrs.tool_command
      || shape === "parallelogram";  // selfci shape
    if (!isInfra) continue;

    const outgoing = graph.edges.filter((e) => e.from === node.id);
    if (outgoing.length === 0) continue;

    const hasFailureCondition = outgoing.some(
      (e) => e.attrs.condition && /outcome\s*!=\s*success|outcome\s*=\s*fail/i.test(e.attrs.condition),
    );
    const hasUnconditionalToGate = outgoing.some((e) => {
      if (e.attrs.condition) return false;
      const target = graph.nodes.find((n) => n.id === e.to);
      return target?.attrs.shape === "diamond";
    });

    if (!hasFailureCondition && !hasUnconditionalToGate) {
      diagnostics.push(diag("failure_path", "warning",
        `Node "${node.id}" has no failure path. If this stage fails, the pipeline will halt. ` +
        `Add a condition="outcome!=success" edge or route through a conditional gate (diamond).`,
        { node_id: node.id },
      ));
    }
  }

  // conditional_gate_coverage: diamond nodes should have edges for both
  // success and non-success outcomes
  for (const node of graph.nodes) {
    if (node.attrs.shape !== "diamond") continue;
    const outgoing = graph.edges.filter((e) => e.from === node.id);
    if (outgoing.length === 0) continue;

    const hasSuccess = outgoing.some(
      (e) => e.attrs.condition && /outcome\s*=\s*success/i.test(e.attrs.condition),
    );
    const hasFailure = outgoing.some(
      (e) => e.attrs.condition && /outcome\s*!=\s*success|outcome\s*=\s*fail/i.test(e.attrs.condition),
    );

    if (hasSuccess && !hasFailure) {
      diagnostics.push(diag("conditional_gate_coverage", "warning",
        `Conditional gate "${node.id}" handles success but not failure. Add an edge with condition="outcome!=success".`,
        { node_id: node.id },
      ));
    }
    if (hasFailure && !hasSuccess) {
      diagnostics.push(diag("conditional_gate_coverage", "warning",
        `Conditional gate "${node.id}" handles failure but not success. Add an edge with condition="outcome=success".`,
        { node_id: node.id },
      ));
    }
  }

  // human_gate_options: hexagon nodes should have at least 2 outgoing edges
  for (const node of graph.nodes) {
    if (node.attrs.shape !== "hexagon") continue;
    const outgoing = graph.edges.filter((e) => e.from === node.id);
    if (outgoing.length < 2) {
      diagnostics.push(diag("human_gate_options", "warning",
        `Human gate "${node.id}" has ${outgoing.length} outgoing edge(s). A gate should offer at least 2 choices.`,
        { node_id: node.id },
      ));
    }
  }

  // prompt_on_llm_nodes
  for (const node of graph.nodes) {
    const handlerType = node.attrs.type || SHAPE_TO_TYPE[node.attrs.shape ?? "box"] || "codergen";
    if (handlerType === "codergen" && !node.attrs.prompt && !node.attrs.label) {
      diagnostics.push(diag("prompt_on_llm_nodes", "warning",
        `Node "${node.id}" resolves to codergen handler but has no prompt or label.`,
        { node_id: node.id },
      ));
    }
  }

  // prompt_file_exists
  for (const node of graph.nodes) {
    const raw = node.attrs.prompt_file as string | undefined;
    if (!raw) continue;
    const paths = raw.split(",").map((p) => p.trim()).filter(Boolean);
    for (const p of paths) {
      const abs = p.startsWith("~/") || p === "~"
        ? resolve(homedir(), p.slice(2))
        : resolve(p);
      if (!existsSync(abs)) {
        diagnostics.push(diag("prompt_file_exists", "warning",
          `Node "${node.id}" references prompt_file "${p}" which does not exist (resolved: ${abs}).`,
          { node_id: node.id, fix: `Create the file at ${abs} or fix the path` },
        ));
      }
    }
  }

  return diagnostics;
}

/**
 * Validate and throw on error-severity diagnostics.
 */
export function validateOrRaise(graph: Graph): Diagnostic[] {
  const diagnostics = validate(graph);
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (errors.length > 0) {
    const msg = errors.map((e) => `  [${e.rule}] ${e.message}`).join("\n");
    throw new Error(`Pipeline validation failed:\n${msg}`);
  }
  return diagnostics;
}

export { findStartNode, findExitNodes };
