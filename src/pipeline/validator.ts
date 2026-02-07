/**
 * Validation and Linting — Section 7 of the Attractor Spec.
 */

import type { Graph, Diagnostic, Severity } from "./types.js";
import { SHAPE_TO_TYPE } from "./types.js";
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
      const knownTypes = Object.values(SHAPE_TO_TYPE);
      if (!knownTypes.includes(node.attrs.type)) {
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
