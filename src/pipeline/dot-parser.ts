/**
 * DOT Parser — Section 2 of the Attractor Spec.
 * Parses a subset of Graphviz DOT syntax into the Graph model.
 */

import type { Graph, GraphNode, GraphEdge, GraphAttrs, NodeAttrs, EdgeAttrs } from "./types.js";

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenKind =
  | "keyword" | "identifier" | "string" | "number" | "boolean"
  | "arrow" | "lbracket" | "rbracket" | "lbrace" | "rbrace"
  | "equals" | "comma" | "semicolon" | "eof";

type Token = { kind: TokenKind; value: string; line: number; col: number };

function tokenize(source: string): Token[] {
  // Strip comments
  source = source.replace(/\/\/.*$/gm, "");
  source = source.replace(/\/\*[\s\S]*?\*\//g, "");

  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const advance = (): string => {
    const ch = source[i++];
    if (ch === "\n") { line++; col = 1; } else { col++; }
    return ch;
  };

  const peek = () => source[i];
  const at = (offset: number) => source[i + offset];

  while (i < source.length) {
    // Skip whitespace
    if (/\s/.test(peek())) { advance(); continue; }

    const startLine = line;
    const startCol = col;

    // Arrow ->
    if (peek() === "-" && at(1) === ">") {
      advance(); advance();
      tokens.push({ kind: "arrow", value: "->", line: startLine, col: startCol });
      continue;
    }

    // Reject undirected --
    if (peek() === "-" && at(1) === "-" && at(2) !== ">") {
      throw new Error(`Line ${line}: Undirected edges (--) are not supported. Use -> for directed edges.`);
    }

    // Single char tokens
    if (peek() === "[") { advance(); tokens.push({ kind: "lbracket", value: "[", line: startLine, col: startCol }); continue; }
    if (peek() === "]") { advance(); tokens.push({ kind: "rbracket", value: "]", line: startLine, col: startCol }); continue; }
    if (peek() === "{") { advance(); tokens.push({ kind: "lbrace", value: "{", line: startLine, col: startCol }); continue; }
    if (peek() === "}") { advance(); tokens.push({ kind: "rbrace", value: "}", line: startLine, col: startCol }); continue; }
    if (peek() === "=") { advance(); tokens.push({ kind: "equals", value: "=", line: startLine, col: startCol }); continue; }
    if (peek() === ",") { advance(); tokens.push({ kind: "comma", value: ",", line: startLine, col: startCol }); continue; }
    if (peek() === ";") { advance(); tokens.push({ kind: "semicolon", value: ";", line: startLine, col: startCol }); continue; }

    // String literal
    if (peek() === '"') {
      advance(); // opening quote
      let str = "";
      while (i < source.length && peek() !== '"') {
        if (peek() === "\\") {
          advance();
          const esc = advance();
          if (esc === "n") str += "\n";
          else if (esc === "t") str += "\t";
          else if (esc === "\\") str += "\\";
          else if (esc === '"') str += '"';
          else str += esc;
        } else {
          str += advance();
        }
      }
      if (i < source.length) advance(); // closing quote
      tokens.push({ kind: "string", value: str, line: startLine, col: startCol });
      continue;
    }

    // Number
    if (/[0-9]/.test(peek()) || (peek() === "-" && /[0-9]/.test(at(1) ?? ""))) {
      let num = advance();
      while (i < source.length && /[0-9.]/.test(peek())) {
        num += advance();
      }
      // Check for duration suffix
      if (i < source.length && /[mshd]/.test(peek())) {
        let suffix = advance();
        if (suffix === "m" && peek() === "s") suffix += advance(); // "ms"
        num += suffix;
        tokens.push({ kind: "string", value: num, line: startLine, col: startCol });
      } else {
        tokens.push({ kind: "number", value: num, line: startLine, col: startCol });
      }
      continue;
    }

    // Identifier or keyword
    if (/[A-Za-z_]/.test(peek())) {
      let id = advance();
      while (i < source.length && /[A-Za-z0-9_.]/.test(peek())) {
        id += advance();
      }
      if (id === "true" || id === "false") {
        tokens.push({ kind: "boolean", value: id, line: startLine, col: startCol });
      } else if (["digraph", "graph", "node", "edge", "subgraph", "strict"].includes(id)) {
        tokens.push({ kind: "keyword", value: id, line: startLine, col: startCol });
      } else {
        tokens.push({ kind: "identifier", value: id, line: startLine, col: startCol });
      }
      continue;
    }

    throw new Error(`Line ${line}: Unexpected character '${peek()}'`);
  }

  tokens.push({ kind: "eof", value: "", line, col });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token { return this.tokens[this.pos]; }
  private advance(): Token { return this.tokens[this.pos++]; }
  private expect(kind: TokenKind, value?: string): Token {
    const tok = this.advance();
    if (tok.kind !== kind || (value !== undefined && tok.value !== value)) {
      throw new Error(`Line ${tok.line}: Expected ${kind}${value ? ` "${value}"` : ""}, got ${tok.kind} "${tok.value}"`);
    }
    return tok;
  }
  private match(kind: TokenKind, value?: string): Token | null {
    if (this.peek().kind === kind && (value === undefined || this.peek().value === value)) {
      return this.advance();
    }
    return null;
  }

  parse(): Graph {
    if (this.match("keyword", "strict")) {
      throw new Error("Line 1: 'strict' modifier is not supported.");
    }
    this.expect("keyword", "digraph");
    const name = this.peek().kind === "identifier" ? this.advance().value : "unnamed";
    this.expect("lbrace");

    const graph: Graph = {
      name,
      attrs: {},
      nodes: [],
      edges: [],
      node_defaults: {},
      edge_defaults: {},
    };

    this.parseBody(graph, graph.node_defaults, graph.edge_defaults);
    this.expect("rbrace");
    return graph;
  }

  private parseBody(graph: Graph, nodeDefaults: NodeAttrs, edgeDefaults: EdgeAttrs): void {
    while (this.peek().kind !== "rbrace" && this.peek().kind !== "eof") {
      this.match("semicolon"); // skip optional semicolons

      if (this.peek().kind === "rbrace" || this.peek().kind === "eof") break;

      // graph [ ... ]
      if (this.peek().kind === "keyword" && this.peek().value === "graph") {
        this.advance();
        if (this.peek().kind === "lbracket") {
          const attrs = this.parseAttrBlock();
          Object.assign(graph.attrs, attrs);
        }
        this.match("semicolon");
        continue;
      }

      // node [ ... ]
      if (this.peek().kind === "keyword" && this.peek().value === "node") {
        this.advance();
        if (this.peek().kind === "lbracket") {
          Object.assign(nodeDefaults, this.parseAttrBlock());
        }
        this.match("semicolon");
        continue;
      }

      // edge [ ... ]
      if (this.peek().kind === "keyword" && this.peek().value === "edge") {
        this.advance();
        if (this.peek().kind === "lbracket") {
          Object.assign(edgeDefaults, this.parseAttrBlock());
        }
        this.match("semicolon");
        continue;
      }

      // subgraph
      if (this.peek().kind === "keyword" && this.peek().value === "subgraph") {
        this.advance();
        let _subName: string | undefined;
        if (this.peek().kind === "identifier") {
          _subName = this.advance().value;
        }
        this.expect("lbrace");
        // Subgraphs are flattened: parse as a nested body with scoped defaults
        const scopedNodeDefaults = { ...nodeDefaults };
        const scopedEdgeDefaults = { ...edgeDefaults };
        this.parseBody(graph, scopedNodeDefaults, scopedEdgeDefaults);
        this.expect("rbrace");
        this.match("semicolon");
        continue;
      }

      // Graph-level attribute: key = value
      if (this.peek().kind === "identifier" && this.tokens[this.pos + 1]?.kind === "equals" &&
          this.tokens[this.pos + 2]?.kind !== "lbracket") {
        // Check it's not a node followed by -> (edge)
        const lookahead = this.tokens.slice(this.pos, this.pos + 4);
        if (lookahead.length >= 3 && !lookahead.some((t) => t.kind === "arrow")) {
          const key = this.advance().value;
          this.expect("equals");
          const value = this.parseValue();
          (graph.attrs as Record<string, unknown>)[key] = value;
          this.match("semicolon");
          continue;
        }
      }

      // Node or edge statement
      if (this.peek().kind === "identifier") {
        this.parseNodeOrEdge(graph, nodeDefaults, edgeDefaults);
        this.match("semicolon");
        continue;
      }

      // Skip unrecognized
      this.advance();
    }
  }

  private parseNodeOrEdge(graph: Graph, nodeDefaults: NodeAttrs, edgeDefaults: EdgeAttrs): void {
    const firstId = this.advance().value;

    // Check for chained edges: A -> B -> C [attrs]
    if (this.peek().kind === "arrow") {
      const nodeIds = [firstId];
      while (this.match("arrow")) {
        nodeIds.push(this.expect("identifier").value);
      }

      const edgeAttrs = this.peek().kind === "lbracket"
        ? this.parseAttrBlock()
        : {};

      // Ensure all referenced nodes exist (create if needed)
      for (const id of nodeIds) {
        if (!graph.nodes.find((n) => n.id === id)) {
          graph.nodes.push({ id, attrs: { ...nodeDefaults, label: nodeDefaults.label ?? id } });
        }
      }

      // Create edges for each pair (chained edges, Section 2.9)
      for (let i = 0; i < nodeIds.length - 1; i++) {
        graph.edges.push({
          from: nodeIds[i],
          to: nodeIds[i + 1],
          attrs: { ...edgeDefaults, ...edgeAttrs } as EdgeAttrs,
        });
      }
      return;
    }

    // Node statement: ID [attrs]
    const attrs = this.peek().kind === "lbracket"
      ? this.parseAttrBlock()
      : {};

    const nodeAttrs = { ...nodeDefaults, ...attrs };
    if (!nodeAttrs.label) nodeAttrs.label = firstId;

    // Update existing or add new
    const existing = graph.nodes.find((n) => n.id === firstId);
    if (existing) {
      Object.assign(existing.attrs, nodeAttrs);
    } else {
      graph.nodes.push({ id: firstId, attrs: nodeAttrs });
    }
  }

  private parseAttrBlock(): Record<string, unknown> {
    this.expect("lbracket");
    const attrs: Record<string, unknown> = {};

    while (this.peek().kind !== "rbracket" && this.peek().kind !== "eof") {
      this.match("comma"); // skip commas
      if (this.peek().kind === "rbracket") break;

      const key = this.advance().value;
      this.expect("equals");
      const value = this.parseValue();
      attrs[key] = value;

      this.match("comma"); // trailing comma
    }

    this.expect("rbracket");
    return attrs;
  }

  private parseValue(): unknown {
    const tok = this.advance();
    if (tok.kind === "string") return tok.value;
    if (tok.kind === "number") {
      return tok.value.includes(".") ? parseFloat(tok.value) : parseInt(tok.value, 10);
    }
    if (tok.kind === "boolean") return tok.value === "true";
    if (tok.kind === "identifier") return tok.value;
    return tok.value;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseDot(source: string): Graph {
  const tokens = tokenize(source);
  const parser = new Parser(tokens);
  return parser.parse();
}
