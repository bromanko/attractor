/**
 * Node Handlers — Section 4 of the Attractor Spec.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname, resolve, isAbsolute, normalize, relative, sep } from "node:path";
import {
  SHAPE_TO_TYPE,
  type Handler, type GraphNode, type Context, type Graph, type Outcome,
  type Interviewer, type CodergenBackend, type Option, type Question,
} from "./types.js";
import {
  WorkspaceCreateHandler,
  WorkspaceMergeHandler,
  WorkspaceCleanupHandler,
  WS_CONTEXT,
  type JjRunner,
} from "./workspace.js";

// ---------------------------------------------------------------------------
// Utility: write status file
// ---------------------------------------------------------------------------

async function writeStatus(stageDir: string, outcome: Outcome): Promise<void> {
  await mkdir(stageDir, { recursive: true });
  await writeFile(
    join(stageDir, "status.json"),
    JSON.stringify({
      outcome: outcome.status,
      preferred_next_label: outcome.preferred_label ?? "",
      suggested_next_ids: outcome.suggested_next_ids ?? [],
      context_updates: outcome.context_updates ?? {},
      notes: outcome.notes ?? "",
    }, null, 2),
    "utf-8",
  );
}

function expandVariables(text: string, graph: Graph, context: Context): string {
  // Replace $goal with graph-level goal attribute
  let result = text.replace(/\$goal/g, (graph.attrs.goal as string) ?? "");

  // Replace $variable.name patterns with context values.
  // Matches $word.word.word (dotted identifiers), longest-match first.
  // IMPORTANT: If no context value exists, keep the original token intact
  // so shell variables like $CANDIDATE continue to work inside tool commands.
  const snapshot = context.snapshot();
  result = result.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)/g, (match, key) => {
    if (key === "goal") return (graph.attrs.goal as string) ?? "";
    if (Object.hasOwn(snapshot, key)) {
      const value = snapshot[key];
      return value == null ? "" : String(value);
    }
    return match;
  });

  return result;
}

function parseCsvAttr(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function slugifyGoal(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "plan";
}

function reviewSectionTitle(key: string): string {
  if (key.startsWith("plan_review")) return "LLM Critique";
  if (key.startsWith("plan.")) return "Plan Draft";
  return key;
}

function collectNonEmptyContextText(keys: string[], context: Context): Map<string, string> {
  const values = new Map<string, string>();
  for (const key of keys) {
    const raw = context.get(key);
    if (raw == null) continue;
    const text = String(raw).trim();
    if (!text) continue;
    values.set(key, text);
  }
  return values;
}

function pickReviewKeys(node: GraphNode, context: Context): string[] {
  const explicit = parseCsvAttr(node.attrs.review_markdown_keys);
  if (explicit.length > 0) return explicit;

  const defaults = [
    "plan._full_response",
    "plan.response",
    "plan_review._full_response",
    "plan_review.response",
  ];
  const nonEmptyValues = collectNonEmptyContextText(defaults, context);
  return defaults.filter((key) => nonEmptyValues.has(key));
}

function buildReviewMarkdown(
  keys: string[],
  context: Context,
  preloadedTexts?: Map<string, string>,
): string | undefined {
  const texts = preloadedTexts ?? collectNonEmptyContextText(keys, context);
  const sections: string[] = [];

  for (const key of keys) {
    const text = texts.get(key);
    if (!text) continue;
    sections.push(`## ${reviewSectionTitle(key)}\n\n${text}`);
  }

  if (sections.length === 0) return undefined;
  return sections.join("\n\n---\n\n");
}

async function writeDraftPlan(
  node: GraphNode,
  context: Context,
  graph: Graph,
  reviewKeys?: string[],
): Promise<string | undefined> {
  const resolvedReviewKeys = reviewKeys ?? pickReviewKeys(node, context);
  const configuredKey = node.attrs.draft_context_key;
  const draftKey = typeof configuredKey === "string"
    ? configuredKey
    : resolvedReviewKeys.find((k) => k.startsWith("plan."));

  if (!draftKey) return undefined;

  const draft = context.get(draftKey);
  if (draft == null || String(draft).trim().length === 0) return undefined;

  const goal = String(graph.attrs.goal ?? context.get("graph.goal") ?? "plan");
  const slug = slugifyGoal(goal);
  const rawDraftPath = node.attrs.draft_path;
  const draftPathTemplate =
    typeof rawDraftPath === "string" && rawDraftPath.trim().length > 0
      ? rawDraftPath
      : "docs/plans/<slug>.draft.md";
  const draftPath = draftPathTemplate.replace(/<slug>/g, slug);

  if (isAbsolute(draftPath)) {
    throw new Error("Invalid draft_path: absolute paths are not allowed");
  }

  const normalizedDraftPath = normalize(draftPath);
  const segments = normalizedDraftPath.split(sep).filter(Boolean);
  if (segments.includes("..")) {
    throw new Error("Invalid draft_path: path traversal is not allowed");
  }

  const baseDir =
    context.getString(WS_CONTEXT.PATH) ||
    context.getString(WS_CONTEXT.REPO_ROOT) ||
    process.cwd();

  const allowedRoot = resolve(baseDir, "docs/plans");
  const absPath = resolve(baseDir, normalizedDraftPath);
  const relToAllowedRoot = relative(allowedRoot, absPath);
  if (relToAllowedRoot.startsWith("..") || isAbsolute(relToAllowedRoot)) {
    throw new Error("Invalid draft_path: must stay under docs/plans");
  }

  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, String(draft), "utf-8");

  return absPath;
}

// ---------------------------------------------------------------------------
// 4.3 Start Handler
// ---------------------------------------------------------------------------

export class StartHandler implements Handler {
  async execute(): Promise<Outcome> {
    return { status: "success" };
  }
}

// ---------------------------------------------------------------------------
// 4.4 Exit Handler
// ---------------------------------------------------------------------------

export class ExitHandler implements Handler {
  async execute(): Promise<Outcome> {
    return { status: "success" };
  }
}

// ---------------------------------------------------------------------------
// 4.5 Codergen Handler (LLM Task)
// ---------------------------------------------------------------------------

export class CodergenHandler implements Handler {
  private _backend: CodergenBackend | undefined;
  private _signal: AbortSignal | undefined;

  constructor(backend?: CodergenBackend, signal?: AbortSignal) {
    this._backend = backend;
    this._signal = signal;
  }

  async execute(node: GraphNode, context: Context, graph: Graph, logsRoot: string): Promise<Outcome> {
    let prompt = node.attrs.prompt || node.attrs.label || node.id;
    prompt = expandVariables(prompt, graph, context);

    const stageDir = join(logsRoot, node.id);
    await mkdir(stageDir, { recursive: true });
    await writeFile(join(stageDir, "prompt.md"), prompt, "utf-8");

    let responseText: string;
    if (this._backend) {
      try {
        const result = await this._backend.run(node, prompt, context, { signal: this._signal });
        if (typeof result === "object" && "status" in result) {
          await writeStatus(stageDir, result as Outcome);
          return result as Outcome;
        }
        responseText = String(result);
      } catch (err) {
        return { status: "fail", failure_reason: String(err) };
      }
    } else {
      responseText = `[Simulated] Response for stage: ${node.id}`;
    }

    await writeFile(join(stageDir, "response.md"), responseText, "utf-8");

    const outcome: Outcome = {
      status: "success",
      notes: `Stage completed: ${node.id}`,
      context_updates: {
        last_stage: node.id,
        last_response: responseText.slice(0, 200),
      },
    };
    await writeStatus(stageDir, outcome);
    return outcome;
  }
}

// ---------------------------------------------------------------------------
// 4.6 Wait For Human Handler
// ---------------------------------------------------------------------------

export class WaitForHumanHandler implements Handler {
  private _interviewer: Interviewer;

  constructor(interviewer: Interviewer) {
    this._interviewer = interviewer;
  }

  async execute(node: GraphNode, context: Context, graph: Graph): Promise<Outcome> {
    const edges = graph.edges.filter((e) => e.from === node.id);

    if (edges.length === 0) {
      return { status: "fail", failure_reason: "No outgoing edges for human gate" };
    }

    const options: Option[] = edges.map((edge) => {
      const label = edge.attrs.label || edge.to;
      const key = parseAcceleratorKey(label);
      return { key, label };
    });

    const promptText = expandVariables(
      String(node.attrs.prompt || node.attrs.label || "Select an option:"),
      graph,
      context,
    );

    const reviewKeys = pickReviewKeys(node, context);
    const reviewTexts = collectNonEmptyContextText(reviewKeys, context);
    const detailsMarkdown = buildReviewMarkdown(reviewKeys, context, reviewTexts);
    const draftPath = await writeDraftPlan(node, context, graph, reviewKeys);

    const question: Question = {
      text: draftPath
        ? `${promptText}\nDraft file: ${draftPath}`
        : promptText,
      details_markdown: detailsMarkdown,
      type: "multiple_choice",
      options,
      stage: node.id,
    };

    const answer = await this._interviewer.ask(question);

    if (answer.value === "timeout") {
      return { status: "retry", failure_reason: "human gate timeout" };
    }
    if (answer.value === "skipped") {
      return { status: "fail", failure_reason: "human skipped interaction" };
    }

    // Find matching choice
    const selected = answer.selected_option ?? options.find((o) => o.key === answer.value) ?? options[0];
    const targetEdge = edges.find((e) => (e.attrs.label || e.to) === selected.label);

    const shouldAskFeedback = /revise/i.test(selected.label);
    let feedback: string | undefined;
    if (shouldAskFeedback) {
      try {
        const feedbackAnswer = await this._interviewer.ask({
          text: "What should be revised in the plan?",
          type: "freeform",
          options: [],
          stage: node.id,
        });
        feedback = feedbackAnswer.text ?? String(feedbackAnswer.value ?? "").trim();
      } catch {
        // Best effort: keep revision flow working even if a non-interactive
        // interviewer implementation does not handle freeform prompts.
      }
    }

    return {
      status: "success",
      suggested_next_ids: targetEdge ? [targetEdge.to] : [edges[0].to],
      context_updates: {
        "human.gate.selected": selected.key,
        "human.gate.label": selected.label,
        ...(feedback != null ? { "human.gate.feedback": feedback } : {}),
        ...(draftPath ? { "human.gate.draft_path": draftPath } : {}),
      },
      notes: draftPath ? `Draft saved at ${draftPath}` : undefined,
    };
  }
}

function parseAcceleratorKey(label: string): string {
  // [K] Label
  let match = label.match(/^\[(\w)\]\s/);
  if (match) return match[1];
  // K) Label
  match = label.match(/^(\w)\)\s/);
  if (match) return match[1];
  // K - Label
  match = label.match(/^(\w)\s-\s/);
  if (match) return match[1];
  // First character
  return label[0]?.toUpperCase() ?? "";
}

// ---------------------------------------------------------------------------
// 4.7 Conditional Handler
// ---------------------------------------------------------------------------

export class ConditionalHandler implements Handler {
  async execute(node: GraphNode, context: Context): Promise<Outcome> {
    // A conditional (diamond) node is a pass-through gate.
    // It forwards the upstream outcome so edge conditions evaluate
    // against the *previous* node's result, not this node's.
    const upstream = context.get("outcome") as string | undefined;
    const status = (upstream === "fail" || upstream === "retry")
      ? upstream as "fail" | "retry"
      : "success";
    return { status, notes: `Conditional gate: forwarding outcome=${status}` };
  }
}

// ---------------------------------------------------------------------------
// 4.10 Tool Handler
// ---------------------------------------------------------------------------

import {
  classifyFailure,
  extractTail,
  buildDigest,
  extractFirstFailingCheck,
  isSelfciCommand,
  type ToolFailureDetails,
} from "./tool-failure.js";

export class ToolHandler implements Handler {
  private _attemptCounters = new Map<string, number>();

  async execute(node: GraphNode, context: Context, graph: Graph, logsRoot: string): Promise<Outcome> {
    const rawCommand = node.attrs.tool_command as string | undefined;
    if (!rawCommand) {
      return { status: "fail", failure_reason: "No tool_command specified" };
    }

    // Expand $goal and $context.key variables in tool_command
    const command = expandVariables(rawCommand, graph, context);

    // Use workspace path as cwd if a workspace is active
    const cwd = context.getString(WS_CONTEXT.PATH) || undefined;

    // Track attempt number for per-attempt artifact storage
    const attemptNum = (this._attemptCounters.get(node.id) ?? 0) + 1;
    this._attemptCounters.set(node.id, attemptNum);

    const artifactDir = logsRoot
      ? join(logsRoot, node.id, `attempt-${attemptNum}`)
      : undefined;

    const startTime = Date.now();

    const { exec } = await import("node:child_process");
    return new Promise((resolve) => {
      const env = { ...process.env, JJ_EDITOR: "true", GIT_EDITOR: "true" };
      const timeoutMs = node.attrs.timeout ? parseInt(String(node.attrs.timeout), 10) * 1000 : 300_000;
      exec(command, { timeout: timeoutMs, cwd, env, maxBuffer: 10 * 1024 * 1024 }, async (error, stdout, stderr) => {
        const durationMs = Date.now() - startTime;

        // Write per-attempt artifacts
        const artifactPaths = { stdout: "", stderr: "", meta: "" };
        if (artifactDir) {
          try {
            await mkdir(artifactDir, { recursive: true });
            artifactPaths.stdout = join(artifactDir, "stdout.log");
            artifactPaths.stderr = join(artifactDir, "stderr.log");
            artifactPaths.meta = join(artifactDir, "meta.json");

            await writeFile(artifactPaths.stdout, stdout, "utf-8");
            await writeFile(artifactPaths.stderr, stderr, "utf-8");
            await writeFile(artifactPaths.meta, JSON.stringify({
              command,
              cwd: cwd ?? process.cwd(),
              exitCode: error ? (error as any).code ?? null : 0,
              signal: error ? (error as any).signal ?? null : null,
              durationMs,
              attempt: attemptNum,
              timestamp: new Date().toISOString(),
            }, null, 2), "utf-8");
          } catch {
            // Best effort — don't fail the handler if artifact writing fails
          }
        }

        if (error) {
          const typedError = error as Error & { code?: string | number; killed?: boolean; signal?: string | null };
          const failureClass = classifyFailure(typedError as any);
          const exitCode = typeof typedError.code === "number" ? typedError.code : null;
          const signal = typedError.signal ?? null;

          const digest = buildDigest({
            command,
            failureClass,
            exitCode,
            signal,
            stdout,
            stderr,
          });

          const firstFailingCheck = isSelfciCommand(command)
            ? extractFirstFailingCheck(stdout, stderr)
            : undefined;

          const toolFailure: ToolFailureDetails = {
            failureClass,
            digest,
            command,
            cwd: cwd ?? process.cwd(),
            exitCode,
            signal,
            durationMs,
            stdoutTail: extractTail(stdout),
            stderrTail: extractTail(stderr),
            artifactPaths,
            firstFailingCheck,
          };

          resolve({
            status: "fail",
            failure_reason: digest,
            tool_failure: toolFailure,
          });
        } else {
          resolve({
            status: "success",
            context_updates: { "tool.output": stdout },
            notes: `Tool completed: ${command}`,
          });
        }
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Handler Registry
// ---------------------------------------------------------------------------

export class HandlerRegistry {
  private _handlers = new Map<string, Handler>();
  private _defaultHandler: Handler;

  constructor(opts?: { backend?: CodergenBackend; interviewer?: Interviewer; jjRunner?: JjRunner; abortSignal?: AbortSignal }) {
    this._defaultHandler = new CodergenHandler(opts?.backend, opts?.abortSignal);

    this.register("start", new StartHandler());
    this.register("exit", new ExitHandler());
    this.register("codergen", this._defaultHandler);
    this.register("conditional", new ConditionalHandler());
    this.register("tool", new ToolHandler());

    // Workspace lifecycle handlers
    this.register("workspace.create", new WorkspaceCreateHandler(opts?.jjRunner));
    this.register("workspace.merge", new WorkspaceMergeHandler(opts?.jjRunner));
    this.register("workspace.cleanup", new WorkspaceCleanupHandler(opts?.jjRunner));

    if (opts?.interviewer) {
      this.register("wait.human", new WaitForHumanHandler(opts.interviewer));
    }
  }

  register(type: string, handler: Handler): void {
    this._handlers.set(type, handler);
  }

  resolve(node: GraphNode): Handler {
    // 1. Explicit type attribute
    if (node.attrs.type) {
      const h = this._handlers.get(node.attrs.type);
      if (h) return h;
    }

    // 2. Shape-based resolution
    const shape = node.attrs.shape ?? "box";
    const handlerType = SHAPE_TO_TYPE[shape];
    if (handlerType) {
      const h = this._handlers.get(handlerType);
      if (h) return h;
    }

    // 3. Default
    return this._defaultHandler;
  }
}
