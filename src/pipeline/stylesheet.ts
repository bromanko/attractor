/**
 * Model Stylesheet — Section 8 of the Attractor Spec.
 * CSS-like rules for per-node LLM model/provider defaults.
 */

import type { Graph, GraphNode } from "./types.js";

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type StyleRule = {
  selector: { type: "universal" | "class" | "id"; value: string };
  specificity: number;
  declarations: Record<string, string>;
};

export function parseStylesheet(source: string): StyleRule[] {
  const rules: StyleRule[] = [];
  const rulePattern = /([*#.][^\{]*)\{([^}]*)\}/g;
  let match: RegExpExecArray | null;

  while ((match = rulePattern.exec(source)) !== null) {
    const selectorStr = match[1].trim();
    const declStr = match[2].trim();

    let selector: StyleRule["selector"];
    let specificity: number;

    if (selectorStr === "*") {
      selector = { type: "universal", value: "*" };
      specificity = 0;
    } else if (selectorStr.startsWith("#")) {
      selector = { type: "id", value: selectorStr.slice(1) };
      specificity = 2;
    } else if (selectorStr.startsWith(".")) {
      selector = { type: "class", value: selectorStr.slice(1) };
      specificity = 1;
    } else {
      continue; // Skip unrecognized selectors
    }

    const declarations: Record<string, string> = {};
    for (const decl of declStr.split(";")) {
      const parts = decl.split(":");
      if (parts.length >= 2) {
        const prop = parts[0].trim();
        const val = parts.slice(1).join(":").trim();
        if (prop && val) {
          declarations[prop] = val;
        }
      }
    }

    rules.push({ selector, specificity, declarations });
  }

  // Sort by specificity (lowest first so higher specificity overwrites)
  rules.sort((a, b) => a.specificity - b.specificity);
  return rules;
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

function nodeClasses(node: GraphNode): Set<string> {
  const classes = new Set<string>();
  if (node.attrs.class) {
    for (const c of (node.attrs.class as string).split(",")) {
      classes.add(c.trim());
    }
  }
  return classes;
}

function selectorMatches(selector: StyleRule["selector"], node: GraphNode): boolean {
  if (selector.type === "universal") return true;
  if (selector.type === "id") return node.id === selector.value;
  if (selector.type === "class") return nodeClasses(node).has(selector.value);
  return false;
}

const RECOGNIZED_PROPERTIES = new Set(["llm_model", "llm_provider", "reasoning_effort"]);

/**
 * Apply the model stylesheet to all nodes in the graph.
 * Higher-specificity rules override lower ones.
 * Explicit node attributes always have highest precedence.
 */
export function applyStylesheet(graph: Graph): void {
  const stylesheet = graph.attrs.model_stylesheet;
  if (!stylesheet || typeof stylesheet !== "string") return;

  const rules = parseStylesheet(stylesheet);

  for (const node of graph.nodes) {
    // Save original explicit attributes
    const explicit = new Set<string>();
    for (const prop of RECOGNIZED_PROPERTIES) {
      if (node.attrs[prop] != null) {
        explicit.add(prop);
      }
    }

    // Apply rules in specificity order (lowest first, so later rules override)
    for (const rule of rules) {
      if (!selectorMatches(rule.selector, node)) continue;
      for (const [prop, value] of Object.entries(rule.declarations)) {
        if (!RECOGNIZED_PROPERTIES.has(prop)) continue;
        // Never override explicit node attributes
        if (explicit.has(prop)) continue;
        (node.attrs as Record<string, unknown>)[prop] = value;
      }
    }
  }
}
