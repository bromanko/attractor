/**
 * AWF2 expression parser + lowering helpers.
 *
 * Supports:
 * - ==, !=
 * - &&, ||, !
 * - parentheses
 * - literals: string, number, boolean
 * - functions: outcome("stage"), output("stage.key"), exists("stage.key")
 *
 * Lowering target:
 * current engine condition language (AND-only clauses), by compiling to DNF
 * and emitting one AND-clause string per disjunct.
 */

export type ExpressionStageRef = {
  fn: "outcome" | "output" | "exists";
  stageId: string;
};

/** Result of compiling an AWF2 expression to engine conditions. */
export type EngineConditions =
  | { kind: "unsatisfiable" }
  | { kind: "unconditional" }
  | { kind: "disjunction"; clauses: string[] };

type Scalar = string | number | boolean;

type TokenKind =
  | "ident"
  | "string"
  | "number"
  | "boolean"
  | "lparen"
  | "rparen"
  | "and"
  | "or"
  | "not"
  | "eq"
  | "neq"
  | "eof";

type Token = { kind: TokenKind; value: string; pos: number };

type FnName = "outcome" | "output" | "exists";

type BoolAtom = { kind: "bool"; value: boolean };
type CompareAtom = { kind: "compare"; fn: Exclude<FnName, "exists">; arg: string; op: "==" | "!="; value: Scalar };
type ExistsAtom = { kind: "exists"; arg: string; negated: boolean };

type ExprNode =
  | BoolAtom
  | { kind: "fn"; fn: FnName; arg: string }
  | CompareAtom
  | { kind: "not"; expr: ExprNode }
  | { kind: "and"; left: ExprNode; right: ExprNode }
  | { kind: "or"; left: ExprNode; right: ExprNode };

type Atom = BoolAtom | CompareAtom | ExistsAtom;

function isWhitespace(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return c === 32 /* space */ || c === 9 /* tab */ || c === 10 /* LF */ || c === 13 /* CR */;
}

function isDigit(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return c >= 48 && c <= 57; /* 0-9 */
}


function isDigitOrDot(ch: string): boolean {
  return isDigit(ch) || ch.charCodeAt(0) === 46; /* . */
}

function isIdentStart(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95; /* A-Z a-z _ */
}

function isIdentContinue(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return (
    (c >= 65 && c <= 90) || /* A-Z */
    (c >= 97 && c <= 122) || /* a-z */
    (c >= 48 && c <= 57) || /* 0-9 */
    c === 95 || /* _ */
    c === 46 /* . */
  );
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  /** Safe indexing: returns the character at `idx` or `undefined` if OOB. */
  const char = (idx: number): string | undefined => source[idx];
  const peek = () => char(i);
  const at = (n: number) => char(i + n);

  while (i < source.length) {
    const ch = peek();
    if (ch == null) break;
    if (isWhitespace(ch)) {
      i++;
      continue;
    }

    if (ch === "(") {
      tokens.push({ kind: "lparen", value: ch, pos: i++ });
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "rparen", value: ch, pos: i++ });
      continue;
    }
    if (ch === "!" && at(1) === "=") {
      tokens.push({ kind: "neq", value: "!=", pos: i });
      i += 2;
      continue;
    }
    if (ch === "=") {
      if (at(1) !== "=") throw new Error(`Expected '==' at position ${i}`);
      tokens.push({ kind: "eq", value: "==", pos: i });
      i += 2;
      continue;
    }
    if (ch === "&" && at(1) === "&") {
      tokens.push({ kind: "and", value: "&&", pos: i });
      i += 2;
      continue;
    }
    if (ch === "|" && at(1) === "|") {
      tokens.push({ kind: "or", value: "||", pos: i });
      i += 2;
      continue;
    }
    if (ch === "!") {
      tokens.push({ kind: "not", value: "!", pos: i++ });
      continue;
    }

    if (ch === '"') {
      const start = i;
      i++; // open quote
      // Fast path: scan for close quote without escapes
      const bodyStart = i;
      let hasEscape = false;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === "\\") {
          hasEscape = true;
          break;
        }
        i++;
      }
      if (!hasEscape) {
        // No escapes — slice directly
        if (char(i) !== '"') throw new Error(`Unterminated string at position ${start}`);
        const value = source.slice(bodyStart, i);
        i++; // close quote
        tokens.push({ kind: "string", value, pos: start });
        continue;
      }
      // Slow path: rebuild with escape processing from bodyStart
      let out = source.slice(bodyStart, i);
      while (i < source.length && char(i) !== '"') {
        if (char(i) === "\\") {
          i++;
          const esc = char(i) ?? "";
          if (esc === "n") out += "\n";
          else if (esc === "t") out += "\t";
          else out += esc;
          i++;
        } else {
          out += char(i) ?? "";
          i++;
        }
      }
      if (char(i) !== '"') throw new Error(`Unterminated string at position ${start}`);
      i++; // close quote
      tokens.push({ kind: "string", value: out, pos: start });
      continue;
    }

    if (isDigit(ch)) {
      const start = i;
      i++;
      while (i < source.length && isDigitOrDot(char(i) ?? "")) i++;
      const num = source.slice(start, i);
      if (!/^[0-9]+(\.[0-9]+)?$/.test(num)) throw new Error(`Invalid number '${num}' at position ${start}`);
      tokens.push({ kind: "number", value: num, pos: start });
      continue;
    }

    if (isIdentStart(ch)) {
      const start = i;
      i++;
      while (i < source.length && isIdentContinue(char(i) ?? "")) i++;
      const ident = source.slice(start, i);
      if (ident === "true" || ident === "false") {
        tokens.push({ kind: "boolean", value: ident, pos: start });
      } else {
        tokens.push({ kind: "ident", value: ident, pos: start });
      }
      continue;
    }

    throw new Error(`Unexpected character '${ch}' at position ${i}`);
  }

  tokens.push({ kind: "eof", value: "", pos: i });
  return tokens;
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    if (this.pos >= this.tokens.length) throw new Error("Unexpected end of tokens");
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    if (this.pos >= this.tokens.length) throw new Error("Unexpected end of tokens");
    return this.tokens[this.pos++]!;
  }

  private expect(kind: TokenKind): Token {
    const tok = this.next();
    if (tok.kind !== kind) throw new Error(`Expected ${kind} at position ${tok.pos}, got ${tok.kind}`);
    return tok;
  }

  private match(kind: TokenKind): boolean {
    if (this.peek().kind !== kind) return false;
    this.pos++;
    return true;
  }

  public parseExpression(): ExprNode {
    const node = this.parseOr();
    if (this.peek().kind !== "eof") {
      throw new Error(`Unexpected token ${this.peek().kind} at position ${this.peek().pos}`);
    }
    return node;
  }

  private parseOr(): ExprNode {
    let left = this.parseAnd();
    while (this.match("or")) {
      const right = this.parseAnd();
      left = { kind: "or", left, right };
    }
    return left;
  }

  private parseAnd(): ExprNode {
    let left = this.parseUnary();
    while (this.match("and")) {
      const right = this.parseUnary();
      left = { kind: "and", left, right };
    }
    return left;
  }

  private parseUnary(): ExprNode {
    if (this.match("not")) {
      return { kind: "not", expr: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ExprNode {
    const tok = this.peek();

    if (this.match("lparen")) {
      const expr = this.parseOr();
      this.expect("rparen");
      return expr;
    }

    if (tok.kind === "boolean") {
      this.next();
      return { kind: "bool", value: tok.value === "true" };
    }

    if (tok.kind === "ident") {
      const fnNode = this.parseFunctionCall();
      const opTok = this.peek();
      if (opTok.kind === "eq" || opTok.kind === "neq") {
        if (fnNode.fn === "exists") {
          throw new Error(`exists(...) does not support ${opTok.value}; use exists(...) or !exists(...)`);
        }
        this.next();
        const lit = this.parseLiteral();
        return {
          kind: "compare",
          fn: fnNode.fn,
          arg: fnNode.arg,
          op: opTok.kind === "eq" ? "==" : "!=",
          value: lit,
        };
      }
      return fnNode;
    }

    throw new Error(`Unexpected token ${tok.kind} at position ${tok.pos}`);
  }

  private parseLiteral(): Scalar {
    const tok = this.next();
    if (tok.kind === "string") return tok.value;
    if (tok.kind === "number") return tok.value.includes(".") ? Number.parseFloat(tok.value) : Number.parseInt(tok.value, 10);
    if (tok.kind === "boolean") return tok.value === "true";
    throw new Error(`Expected literal at position ${tok.pos}, got ${tok.kind}`);
  }

  private parseFunctionCall(): Extract<ExprNode, { kind: "fn" }> {
    const fnTok = this.expect("ident");
    const fnName = fnTok.value;
    if (fnName !== "outcome" && fnName !== "output" && fnName !== "exists") {
      throw new Error(`Unknown function ${fnName} at position ${fnTok.pos}`);
    }
    const fn: FnName = fnName;

    this.expect("lparen");
    const argTok = this.expect("string");
    this.expect("rparen");

    return { kind: "fn", fn, arg: argTok.value };
  }
}

function parseExpression(expr: string): ExprNode {
  return new Parser(tokenize(expr)).parseExpression();
}

function toNnf(node: ExprNode, negated = false): ExprNode {
  switch (node.kind) {
    case "bool":
      return { kind: "bool", value: negated ? !node.value : node.value };
    case "fn":
      return negated ? { kind: "not", expr: node } : node;
    case "compare":
      if (!negated) return node;
      return { ...node, op: node.op === "==" ? "!=" : "==" };
    case "not":
      return toNnf(node.expr, !negated);
    case "and":
      if (!negated) return { kind: "and", left: toNnf(node.left, false), right: toNnf(node.right, false) };
      return { kind: "or", left: toNnf(node.left, true), right: toNnf(node.right, true) };
    case "or":
      if (!negated) return { kind: "or", left: toNnf(node.left, false), right: toNnf(node.right, false) };
      return { kind: "and", left: toNnf(node.left, true), right: toNnf(node.right, true) };
  }
}

function atomFromNnf(node: ExprNode): Atom {
  if (node.kind === "bool") return { kind: "bool", value: node.value };
  if (node.kind === "compare") return node;
  if (node.kind === "fn") {
    if (node.fn !== "exists") throw new Error(`Bare ${node.fn}(...) requires comparison`);
    return { kind: "exists", arg: node.arg, negated: false };
  }
  if (node.kind === "not" && node.expr.kind === "fn" && node.expr.fn === "exists") {
    return { kind: "exists", arg: node.expr.arg, negated: true };
  }
  throw new Error("Expression lowering expected atom in NNF");
}

/** Maximum number of disjuncts (clauses) the DNF expansion may produce. */
const MAX_DNF_CLAUSES = 128;

function dnf(node: ExprNode): Atom[][] {
  if (node.kind === "and") {
    const left = dnf(node.left);
    const right = dnf(node.right);
    const out: Atom[][] = [];
    for (const a of left) {
      for (const b of right) {
        out.push([...a, ...b]);
        if (out.length > MAX_DNF_CLAUSES) {
          throw new Error(
            `Expression too complex: DNF expansion exceeds ${MAX_DNF_CLAUSES} clauses`,
          );
        }
      }
    }
    return out;
  }

  if (node.kind === "or") {
    const result = [...dnf(node.left), ...dnf(node.right)];
    if (result.length > MAX_DNF_CLAUSES) {
      throw new Error(
        `Expression too complex: DNF expansion exceeds ${MAX_DNF_CLAUSES} clauses`,
      );
    }
    return result;
  }

  const atom = atomFromNnf(node);
  if (atom.kind === "bool") {
    return atom.value ? [[]] : [];
  }
  return [[atom]];
}

function scalarToString(value: Scalar): string {
  return String(value);
}

function atomToEngineClause(atom: Atom): string | undefined {
  if (atom.kind === "bool") {
    return atom.value ? undefined : "outcome=__never__";
  }

  if (atom.kind === "exists") {
    return atom.negated ? `context.${atom.arg}=` : `context.${atom.arg}!=`;
  }

  if (atom.kind === "compare") {
    if (atom.fn === "outcome") {
      const op = atom.op === "==" ? "=" : "!=";
      return `context.${atom.arg}.status${op}${scalarToString(atom.value)}`;
    }

    // output(...)
    const op = atom.op === "==" ? "=" : "!=";
    return `context.${atom.arg}${op}${scalarToString(atom.value)}`;
  }

  const _exhaustive: never = atom;
  throw new Error(`Unhandled atom kind: ${(_exhaustive as Atom).kind}`);
}

/**
 * Compile an AWF2 expression into engine conditions.
 *
 * Returns a tagged union:
 * - `{ kind: "unsatisfiable" }` for expressions that are always false
 * - `{ kind: "unconditional" }` for expressions that are always true
 * - `{ kind: "disjunction", clauses: [...] }` for actual conditions in DNF form
 */
function compileFromAst(ast: ExprNode): EngineConditions {
  const nnfAst = toNnf(ast, false);
  const conjunctions = dnf(nnfAst);

  if (conjunctions.length === 0) return { kind: "unsatisfiable" };

  const clauses: Array<string | undefined> = conjunctions.map((atoms) => {
    const parts = atoms
      .map(atomToEngineClause)
      .filter((c): c is string => typeof c === "string" && c.length > 0);
    if (parts.length === 0) return undefined;
    return parts.join(" && ");
  });

  // If every conjunction reduced to unconditional (undefined), the whole
  // expression is unconditional.  If *any* conjunction is unconditional the
  // disjunction is unconditional (true || X === true).
  if (clauses.some((c) => c === undefined)) return { kind: "unconditional" };

  return { kind: "disjunction", clauses: clauses as string[] };
}

/**
 * Compile an AWF2 expression into engine conditions. Convenience wrapper.
 *
 * Returns a tagged union:
 * - `{ kind: "unsatisfiable" }` for expressions that are always false
 * - `{ kind: "unconditional" }` for expressions that are always true
 * - `{ kind: "disjunction", clauses: [...] }` for actual conditions in DNF form
 */
export function compileAwf2ExprToEngineConditions(expr: string): EngineConditions {
  return parseAwf2Expr(expr).compile();
}

function visit(node: ExprNode, out: ExpressionStageRef[]): void {
  switch (node.kind) {
    case "bool":
      return;
    case "fn": {
      const stageId = node.fn === "outcome" ? node.arg : node.arg.split(".")[0] ?? "";
      out.push({ fn: node.fn, stageId });
      return;
    }
    case "compare": {
      const stageId = node.fn === "outcome" ? node.arg : node.arg.split(".")[0] ?? "";
      out.push({ fn: node.fn, stageId });
      return;
    }
    case "not":
      visit(node.expr, out);
      return;
    case "and":
    case "or":
      visit(node.left, out);
      visit(node.right, out);
      return;
  }
}

/** A parsed AWF2 expression. Parse once, query multiple times. */
export interface ParsedExpression {
  /** Collect stage references (outcome/output/exists) from the expression. */
  stageRefs(): ExpressionStageRef[];
  /** Compile to engine conditions (DNF form). */
  compile(): EngineConditions;
}

/** Parse an AWF2 expression string. Throws on malformed input. */
export function parseAwf2Expr(expr: string): ParsedExpression {
  const ast = parseExpression(expr);

  let cachedRefs: ExpressionStageRef[] | undefined;
  let cachedConditions: EngineConditions | undefined;

  return {
    stageRefs(): ExpressionStageRef[] {
      if (cachedRefs === undefined) {
        cachedRefs = [];
        visit(ast, cachedRefs);
      }
      return cachedRefs;
    },
    compile(): EngineConditions {
      if (cachedConditions === undefined) {
        cachedConditions = compileFromAst(ast);
      }
      return cachedConditions;
    },
  };
}

/** Collect stage references from an expression string. Convenience wrapper. */
export function collectExpressionStageRefs(expr: string): ExpressionStageRef[] {
  return parseAwf2Expr(expr).stageRefs();
}

/** Syntax check helper. Returns true if `expr` parses without error. */
export function isPlausibleExpression(expr: string): boolean {
  const trimmed = expr.trim();
  if (!trimmed) return false;
  try {
    parseExpression(trimmed);
    return true;
  } catch {
    return false;
  }
}
