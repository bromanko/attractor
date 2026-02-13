/**
 * Serialize an Attractor {@link Graph} back to DOT format.
 *
 * This produces a valid Graphviz DOT string suitable for piping to `dot`,
 * `graph-easy`, or any other DOT consumer.
 */

import type { Graph, GraphNode, GraphEdge, NodeAttrs, EdgeAttrs } from "./types.js";

/** Escape a string for use as a DOT attribute value. */
function dotEscape(value: string): string {
  // Wrap in double quotes, escaping embedded quotes and backslashes
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Format a single `key=value` DOT attribute. */
function formatAttr(key: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const str = String(value);
  return `${key}=${dotEscape(str)}`;
}

/** Build a DOT attribute list string like `[shape="diamond", label="foo"]`. */
function attrList(attrs: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    const formatted = formatAttr(key, value);
    if (formatted) parts.push(formatted);
  }
  return parts.length > 0 ? ` [${parts.join(", ")}]` : "";
}

/** Pick the displayable subset of node attributes for DOT output. */
function nodeDisplayAttrs(attrs: NodeAttrs): { label?: string; shape?: string } {
  const out: { label?: string; shape?: string } = {};
  if (attrs.label) out.label = attrs.label;
  if (attrs.shape) out.shape = attrs.shape;
  return out;
}

/** Pick the displayable subset of edge attributes for DOT output. */
function edgeDisplayAttrs(attrs: EdgeAttrs): { label?: string } {
  const out: { label?: string } = {};
  // Show explicit label if set; otherwise fall back to condition as a display label.
  // When both exist, combine them so neither is silently lost.
  if (attrs.label && attrs.condition) {
    out.label = `${attrs.label} [${attrs.condition}]`;
  } else if (attrs.label) {
    out.label = attrs.label;
  } else if (attrs.condition) {
    out.label = attrs.condition;
  }
  return out;
}

/** Serialize a {@link Graph} to a DOT format string. */
export function graphToDot(graph: Graph): string {
  const lines: string[] = [];
  const indent = "  ";

  lines.push(`digraph ${dotEscape(graph.name)} {`);

  // Graph-level attributes
  if (graph.attrs.label) {
    lines.push(`${indent}label=${dotEscape(graph.attrs.label)};`);
  }
  lines.push(`${indent}rankdir="TB";`);
  lines.push("");

  // Nodes
  for (const node of graph.nodes) {
    lines.push(`${indent}${dotEscape(node.id)}${attrList(nodeDisplayAttrs(node.attrs))};`);
  }
  lines.push("");

  // Edges
  for (const edge of graph.edges) {
    lines.push(
      `${indent}${dotEscape(edge.from)} -> ${dotEscape(edge.to)}${attrList(edgeDisplayAttrs(edge.attrs))};`,
    );
  }

  lines.push("}");
  return lines.join("\n") + "\n";
}
