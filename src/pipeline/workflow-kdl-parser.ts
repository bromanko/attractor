import type {
  WorkflowDecisionRoute,
  WorkflowHumanOption,
  WorkflowModelProfile,
  WorkflowStage,
  WorkflowTransition,
  WorkflowDefinition,
} from "./workflow-types.js";

type Scalar = string | number | boolean;

type TokenKind = "ident" | "string" | "number" | "boolean" | "lbrace" | "rbrace" | "equals" | "newline" | "eof";

type Token = {
  kind: TokenKind;
  value: string;
  line: number;
  col: number;
};

type KdlNode = {
  name: string;
  args: Scalar[];
  props: Record<string, Scalar>;
  children: KdlNode[];
};

function tokenize(source: string): Token[] {
  const text = source;
  const tokens: Token[] = [];

  let i = 0;
  let line = 1;
  let col = 1;

  const peek = () => text[i];
  const at = (n: number) => text[i + n];
  const advance = (): string => {
    const ch = text[i++]!;
    if (ch === "\n") {
      line++;
      col = 1;
    } else {
      col++;
    }
    return ch;
  };

  while (i < text.length) {
    const ch = peek();

    // Line comments: // until end of line
    if (ch === "/" && at(1) === "/") {
      while (i < text.length && peek() !== "\n") advance();
      continue;
    }

    // Block comments: /* ... */
    if (ch === "/" && at(1) === "*") {
      const startLine = line;
      const startCol = col;
      advance(); // /
      advance(); // *
      while (i < text.length) {
        if (peek() === "*" && at(1) === "/") {
          advance(); // *
          advance(); // /
          break;
        }
        advance();
      }
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      advance();
      continue;
    }
    if (ch === "\n" || ch === ";") {
      tokens.push({ kind: "newline", value: "\n", line, col });
      advance();
      continue;
    }
    if (ch === "{") {
      tokens.push({ kind: "lbrace", value: "{", line, col });
      advance();
      continue;
    }
    if (ch === "}") {
      tokens.push({ kind: "rbrace", value: "}", line, col });
      advance();
      continue;
    }
    if (ch === "=") {
      tokens.push({ kind: "equals", value: "=", line, col });
      advance();
      continue;
    }

    if (ch === '"') {
      const startLine = line;
      const startCol = col;
      advance();
      let out = "";
      while (i < text.length && peek() !== '"') {
        if (peek() === "\\") {
          advance();
          const esc = advance();
          if (esc === "n") out += "\n";
          else if (esc === "t") out += "\t";
          else out += esc;
        } else {
          out += advance();
        }
      }
      if (peek() !== '"') {
        throw new Error(`KDL parse error at ${startLine}:${startCol}: unterminated string`);
      }
      advance();
      tokens.push({ kind: "string", value: out, line: startLine, col: startCol });
      continue;
    }

    if (/[0-9-]/.test(ch)) {
      const startLine = line;
      const startCol = col;
      let num = advance();
      while (i < text.length && /[0-9.]/.test(peek())) num += advance();
      if (/^-?[0-9]+(\.[0-9]+)?$/.test(num)) {
        tokens.push({ kind: "number", value: num, line: startLine, col: startCol });
        continue;
      }
      throw new Error(`KDL parse error at ${startLine}:${startCol}: invalid number "${num}"`);
    }

    if (/[A-Za-z_]/.test(ch)) {
      const startLine = line;
      const startCol = col;
      let ident = advance();
      while (i < text.length && /[A-Za-z0-9_.-]/.test(peek())) ident += advance();
      if (ident === "true" || ident === "false") {
        tokens.push({ kind: "boolean", value: ident, line: startLine, col: startCol });
      } else {
        tokens.push({ kind: "ident", value: ident, line: startLine, col: startCol });
      }
      continue;
    }

    throw new Error(`KDL parse error at ${line}:${col}: unexpected character '${ch}'`);
  }

  tokens.push({ kind: "eof", value: "", line, col });
  return tokens;
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private expect(kind: TokenKind, value?: string): Token {
    const tok = this.next();
    if (tok.kind !== kind || (value !== undefined && tok.value !== value)) {
      throw new Error(`KDL parse error at ${tok.line}:${tok.col}: expected ${kind}${value ? ` "${value}"` : ""}, got ${tok.kind} "${tok.value}"`);
    }
    return tok;
  }

  private match(kind: TokenKind, value?: string): boolean {
    const tok = this.peek();
    if (tok.kind !== kind) return false;
    if (value !== undefined && tok.value !== value) return false;
    this.pos++;
    return true;
  }

  parseNodes(untilRbrace = false): KdlNode[] {
    const nodes: KdlNode[] = [];

    while (true) {
      while (this.match("newline")) {}

      const tok = this.peek();
      if (tok.kind === "eof") break;
      if (tok.kind === "rbrace") {
        if (!untilRbrace) {
          throw new Error(`KDL parse error at ${tok.line}:${tok.col}: unexpected '}'`);
        }
        break;
      }

      nodes.push(this.parseNode());

      while (this.match("newline")) {}
    }

    return nodes;
  }

  private parseScalar(tok: Token): Scalar {
    if (tok.kind === "string") return tok.value;
    if (tok.kind === "number") return tok.value.includes(".") ? Number.parseFloat(tok.value) : Number.parseInt(tok.value, 10);
    if (tok.kind === "boolean") return tok.value === "true";
    if (tok.kind === "ident") return tok.value;
    throw new Error(`KDL parse error at ${tok.line}:${tok.col}: expected scalar, got ${tok.kind}`);
  }

  private parseNode(): KdlNode {
    const nameTok = this.expect("ident");
    const name = nameTok.value;
    const args: Scalar[] = [];
    const props: Record<string, Scalar> = {};

    while (true) {
      const tok = this.peek();
      if (tok.kind === "newline" || tok.kind === "lbrace" || tok.kind === "rbrace" || tok.kind === "eof") {
        break;
      }

      if (tok.kind === "ident" && this.tokens[this.pos + 1]?.kind === "equals") {
        const key = this.next().value;
        this.expect("equals");
        const valueTok = this.next();
        props[key] = this.parseScalar(valueTok);
        continue;
      }

      args.push(this.parseScalar(this.next()));
    }

    const children: KdlNode[] = [];
    if (this.match("lbrace")) {
      children.push(...this.parseNodes(true));
      this.expect("rbrace");
    }

    return { name, args, props, children };
  }
}

function scalarString(node: KdlNode, index: number, fieldName: string): string {
  const value = node.args[index];
  if (typeof value !== "string") {
    throw new Error(`KDL conversion error: node "${node.name}" requires string arg ${index} for ${fieldName}`);
  }
  return value;
}

function scalarInt(node: KdlNode, index: number, fieldName: string): number {
  const value = node.args[index];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`KDL conversion error: node "${node.name}" requires int arg ${index} for ${fieldName}`);
  }
  return value;
}

function scalarBoolean(node: KdlNode, index: number, fieldName: string): boolean {
  const value = node.args[index];
  if (typeof value !== "boolean") {
    throw new Error(`KDL conversion error: node "${node.name}" requires boolean arg ${index} for ${fieldName}, got ${typeof value} (${JSON.stringify(value)})`);
  }
  return value;
}

function propString(node: KdlNode, key: string): string | undefined {
  const val = node.props[key];
  return typeof val === "string" ? val : undefined;
}

function propNumber(node: KdlNode, key: string): number | undefined {
  const val = node.props[key];
  return typeof val === "number" ? val : undefined;
}

function propBoolean(node: KdlNode, key: string): boolean | undefined {
  const val = node.props[key];
  return typeof val === "boolean" ? val : undefined;
}

function parseModels(children: KdlNode[]): WorkflowDefinition["models"] {
  const models: NonNullable<WorkflowDefinition["models"]> = {};
  const profiles: Record<string, WorkflowModelProfile> = {};

  for (const node of children) {
    if (node.name === "default") {
      models.default = scalarString(node, 0, "models.default");
      continue;
    }
    if (node.name === "profile") {
      const profileName = scalarString(node, 0, "models.profile name");
      profiles[profileName] = {
        model: propString(node, "model"),
        provider: propString(node, "provider"),
        reasoning_effort: propString(node, "reasoning_effort"),
      };
    }
  }

  if (Object.keys(profiles).length > 0) {
    models.profile = profiles;
  }

  return Object.keys(models).length > 0 ? models : undefined;
}

function parseRetry(children: KdlNode[]): WorkflowStage["retry"] {
  const retryNode = children.find((c) => c.name === "retry");
  if (!retryNode) return undefined;

  const maxAttempts = propNumber(retryNode, "max_attempts");
  if (maxAttempts == null) {
    throw new Error(`KDL conversion error: retry requires max_attempts`);
  }

  const backoffRaw = propString(retryNode, "backoff");
  if (backoffRaw && backoffRaw !== "none" && backoffRaw !== "fixed" && backoffRaw !== "exponential") {
    throw new Error(`KDL conversion error: invalid retry backoff "${backoffRaw}"`);
  }
  const backoff = backoffRaw as "none" | "fixed" | "exponential" | undefined;

  return {
    max_attempts: maxAttempts,
    backoff,
    delay: propString(retryNode, "delay"),
    max_delay: propString(retryNode, "max_delay"),
  };
}

function parseHumanOptions(stageNode: KdlNode): WorkflowHumanOption[] {
  const options: WorkflowHumanOption[] = [];
  for (const child of stageNode.children) {
    if (child.name !== "option") continue;
    options.push({
      key: scalarString(child, 0, `option key (${stageNode.args[0]})`),
      label: propString(child, "label") ?? scalarString(child, 0, "option label fallback"),
      to: propString(child, "to") ?? "",
    });
  }
  return options;
}

function parseDecisionRoutes(stageNode: KdlNode): WorkflowDecisionRoute[] {
  const routes: WorkflowDecisionRoute[] = [];
  for (const child of stageNode.children) {
    if (child.name !== "route") continue;
    const when = propString(child, "when") ?? "";
    const to = propString(child, "to") ?? "";
    routes.push({ when, to, priority: propNumber(child, "priority") });
  }
  return routes;
}

function parseStage(stageNode: KdlNode): WorkflowStage {
  const id = scalarString(stageNode, 0, "stage id");
  const kind = propString(stageNode, "kind") as WorkflowStage["kind"] | undefined;
  if (!kind) {
    throw new Error(`KDL conversion error: stage "${id}" requires kind="..."`);
  }

  const retry = parseRetry(stageNode.children);
  const model_profile = propString(stageNode, "model_profile");

  if (kind === "llm") {
    return {
      id,
      kind,
      prompt: propString(stageNode, "prompt"),
      prompt_file: propString(stageNode, "prompt_file"),
      model: propString(stageNode, "model"),
      provider: propString(stageNode, "provider"),
      reasoning_effort: propString(stageNode, "reasoning_effort"),
      auto_status: propBoolean(stageNode, "auto_status"),
      goal_gate: propBoolean(stageNode, "goal_gate"),
      response_key_base: propString(stageNode, "response_key_base"),
      retry,
      model_profile,
    };
  }

  if (kind === "tool") {
    const command = propString(stageNode, "command");
    if (!command) {
      throw new Error(`KDL conversion error: tool stage "${id}" requires command`);
    }
    return {
      id,
      kind,
      command,
      cwd: propString(stageNode, "cwd"),
      timeout: propString(stageNode, "timeout"),
      retry,
      model_profile,
    };
  }

  if (kind === "human") {
    const promptNode = stageNode.children.find((c) => c.name === "prompt");
    const prompt = promptNode ? scalarString(promptNode, 0, "human.prompt") : propString(stageNode, "prompt");
    if (!prompt) {
      throw new Error(`KDL conversion error: human stage "${id}" requires prompt`);
    }

    const requireFeedback = stageNode.children
      .filter((c) => c.name === "require_feedback_on")
      .map((c) => scalarString(c, 0, "require_feedback_on"));

    const detailsFromNode = stageNode.children.find((c) => c.name === "details_from");
    const reReviewNode = stageNode.children.find((c) => c.name === "re_review");

    return {
      id,
      kind,
      prompt,
      options: parseHumanOptions(stageNode),
      require_feedback_on: requireFeedback.length > 0 ? requireFeedback : undefined,
      details_from: detailsFromNode ? scalarString(detailsFromNode, 0, "details_from") : undefined,
      re_review: reReviewNode ? scalarBoolean(reReviewNode, 0, "re_review") : propBoolean(stageNode, "re_review"),
      retry,
      model_profile,
    };
  }

  if (kind === "decision") {
    return {
      id,
      kind,
      routes: parseDecisionRoutes(stageNode),
      retry,
      model_profile,
    };
  }

  if (kind === "exit" || kind === "workspace.create" || kind === "workspace.merge" || kind === "workspace.cleanup") {
    return {
      id,
      kind,
      workspace_name: propString(stageNode, "workspace_name"),
      retry,
      model_profile,
    };
  }

  throw new Error(`KDL conversion error: unknown stage kind "${kind}" for stage "${id}"`);
}

function parseTransitions(nodes: KdlNode[]): WorkflowTransition[] {
  const transitions: WorkflowTransition[] = [];
  for (const node of nodes) {
    if (node.name !== "transition") continue;
    const from = propString(node, "from") ?? "";
    const to = propString(node, "to") ?? "";
    transitions.push({
      from,
      to,
      when: propString(node, "when"),
      priority: propNumber(node, "priority"),
    });
  }
  return transitions;
}

export function parseWorkflowKdl(source: string): WorkflowDefinition {
  const parser = new Parser(tokenize(source));
  const nodes = parser.parseNodes(false);

  if (nodes.length !== 1 || nodes[0]?.name !== "workflow") {
    throw new Error("KDL conversion error: expected single root node: workflow \"name\" { ... }");
  }

  const root = nodes[0]!;
  const name = scalarString(root, 0, "workflow name");

  const versionNode = root.children.find((c) => c.name === "version");
  const startNode = root.children.find((c) => c.name === "start");
  const descriptionNode = root.children.find((c) => c.name === "description");
  const goalNode = root.children.find((c) => c.name === "goal");

  if (!versionNode) throw new Error("KDL conversion error: missing version node");
  if (!startNode) throw new Error("KDL conversion error: missing start node");

  const version = scalarInt(versionNode, 0, "workflow.version");
  if (version !== 2) {
    throw new Error(`KDL conversion error: unsupported version ${version}; expected 2`);
  }

  const modelsNode = root.children.find((c) => c.name === "models");
  const stageNodes = root.children.filter((c) => c.name === "stage");

  const workflow: WorkflowDefinition = {
    version: 2,
    name,
    description: descriptionNode ? scalarString(descriptionNode, 0, "workflow.description") : undefined,
    goal: goalNode ? scalarString(goalNode, 0, "workflow.goal") : undefined,
    start: scalarString(startNode, 0, "workflow.start"),
    models: modelsNode ? parseModels(modelsNode.children) : undefined,
    stages: stageNodes.map(parseStage),
    transitions: parseTransitions(root.children),
  };

  return workflow;
}
