/**
 * Shared utility for determining whether status markers should be parsed
 * for a given pipeline node.
 */

import type { GraphNode } from "./types.js";

/**
 * Whether status markers (`[STATUS: ...]`) should be honoured for this node.
 *
 * Codergen nodes (shape `box` / unset) default to *ignoring* status markers
 * because LLMs that make code changes are unreliable self-assessors.  Only
 * verification stages — reviews, checks — should determine pass/fail.
 *
 * A node can opt in explicitly with `auto_status=true` (or the DOT string
 * `"true"`).  All non-codergen node types always honour markers.
 */
export function shouldParseStatusMarkers(node: GraphNode): boolean {
  const autoStatus = node.attrs.auto_status;
  // Explicit opt-in / opt-out always wins.
  if (autoStatus === true || autoStatus === "true") return true;
  if (autoStatus === false || autoStatus === "false") return false;

  // Default: codergen nodes (box or unset shape) do NOT self-assess.
  const shape = node.attrs.shape ?? "box";
  if (shape === "box") return false;

  // Everything else (tools, gates, conditionals, …) honours markers.
  return true;
}
