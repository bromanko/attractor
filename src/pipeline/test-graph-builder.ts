/**
 * Test-only helper for building Graph objects inline.
 *
 * Provides a compact `graph()` function that constructs a valid Graph IR
 * from structured parameters.
 */

import type { Graph, GraphAttrs, GraphNode, GraphEdge, NodeAttrs, EdgeAttrs } from "./types.js";

export type NodeSpec = {
  id: string;
  shape?: string;
  label?: string;
  prompt?: string;
  [key: string]: unknown;
};

export type EdgeSpec = {
  from: string;
  to: string;
  condition?: string;
  weight?: number;
  label?: string;
  [key: string]: unknown;
};

export type GraphSpec = {
  name?: string;
  attrs?: GraphAttrs;
  nodes: NodeSpec[];
  edges: EdgeSpec[];
  nodeDefaults?: NodeAttrs;
  edgeDefaults?: EdgeAttrs;
};

/**
 * Build a Graph from a concise spec.
 *
 * Usage:
 * ```ts
 * const g = graph({
 *   attrs: { goal: "Test" },
 *   nodes: [
 *     { id: "start", shape: "Mdiamond" },
 *     { id: "work", shape: "box", prompt: "Do work" },
 *     { id: "exit", shape: "Msquare" },
 *   ],
 *   edges: [
 *     { from: "start", to: "work" },
 *     { from: "work", to: "exit" },
 *   ],
 * });
 * ```
 */
export function graph(spec: GraphSpec): Graph {
  const nodes: GraphNode[] = spec.nodes.map(({ id, shape, label, prompt, ...rest }) => ({
    id,
    attrs: {
      ...(shape != null ? { shape } : {}),
      ...(label != null ? { label } : {}),
      ...(prompt != null ? { prompt } : {}),
      ...rest,
    } as NodeAttrs,
  }));

  const edges: GraphEdge[] = spec.edges.map(({ from, to, condition, weight, label, ...rest }) => ({
    from,
    to,
    attrs: {
      ...(condition != null ? { condition } : {}),
      ...(weight != null ? { weight } : {}),
      ...(label != null ? { label } : {}),
      ...rest,
    } as EdgeAttrs,
  }));

  return {
    name: spec.name ?? "Test",
    attrs: spec.attrs ?? {},
    nodes,
    edges,
    node_defaults: spec.nodeDefaults ?? {},
    edge_defaults: spec.edgeDefaults ?? {},
  };
}
