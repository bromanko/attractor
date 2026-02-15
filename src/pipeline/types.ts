/**
 * Attractor Pipeline Engine — Core types.
 * Implements the Attractor Specification.
 */

// ---------------------------------------------------------------------------
// Graph model
// ---------------------------------------------------------------------------

export type NodeAttrs = {
  label?: string;
  shape?: string;
  type?: string;
  prompt?: string;
  max_retries?: number;
  goal_gate?: boolean;
  retry_target?: string;
  fallback_retry_target?: string;
  fidelity?: string;
  thread_id?: string;
  class?: string;
  timeout?: string;
  llm_model?: string;
  llm_provider?: string;
  reasoning_effort?: string;
  auto_status?: boolean | "true" | "false";
  allow_partial?: boolean;
  /**
   * When true (the default for human gates), selecting a "Revise"-style option
   * records the gate's approve targets so the engine can redirect back to
   * this gate if the revised work tries to reach an approve target without
   * passing through the gate again.
   *
   * Accepts `boolean` or the string `"false"` / `"true"` (which parsers
   * may emit for quoted attribute values).
   */
  re_review?: boolean | string;
  [key: string]: unknown;
};

export type EdgeAttrs = {
  label?: string;
  condition?: string;
  weight?: number;
  fidelity?: string;
  thread_id?: string;
  loop_restart?: boolean;
};

export type GraphNode = {
  id: string;
  attrs: NodeAttrs;
};

export type GraphEdge = {
  from: string;
  to: string;
  attrs: EdgeAttrs;
};

export type GraphAttrs = {
  goal?: string;
  label?: string;
  default_max_retry?: number;
  retry_target?: string;
  fallback_retry_target?: string;
  default_fidelity?: string;
  [key: string]: unknown;
};

export type Graph = {
  name: string;
  attrs: GraphAttrs;
  nodes: GraphNode[];
  edges: GraphEdge[];
  node_defaults: NodeAttrs;
  edge_defaults: EdgeAttrs;
};

// ---------------------------------------------------------------------------
// Handler types (Section 4)
// ---------------------------------------------------------------------------

/** Stage execution outcome status. */
export type StageStatus = "success" | "fail" | "partial_success" | "retry" | "skipped" | "cancelled";

/** Known failure class values for tool stages. */
export type ToolFailureClass = "exit_nonzero" | "timeout" | "spawn_error";

/**
 * Protocol/transient failure classes.
 * Used by backends to classify failures that may be retried automatically
 * (e.g. skipped tool results, missing status markers from empty responses).
 */
export type ProtocolFailureClass =
  | "missing_status_marker"
  | "tool_result_skipped"
  | "empty_response";

/** Structured failure details from a tool stage. */
export type ToolStageFailure = {
  failureClass: ToolFailureClass;
  digest: string;
  command: string;
  cwd?: string;
  exitCode?: number | null;
  signal?: string | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  artifactPaths: {
    stdout: string;
    stderr: string;
    meta: string;
  };
  firstFailingCheck?: string;
};

/** The result of executing a node handler. */
export type Outcome = {
  status: StageStatus;
  preferred_label?: string;
  suggested_next_ids?: string[];
  context_updates?: Record<string, unknown>;
  notes?: string;
  failure_reason?: string;
  /** Protocol/transient failure class for retry logic. */
  failure_class?: ProtocolFailureClass;
  /** Structured failure details (populated by tool stages). */
  tool_failure?: ToolStageFailure;
};

/** Handler interface — every node handler implements this. */
export interface Handler {
  execute(
    node: GraphNode,
    context: Context,
    graph: Graph,
    logs_root: string,
  ): Promise<Outcome>;
}

// ---------------------------------------------------------------------------
// Shape-to-handler-type mapping (Section 2.8)
// ---------------------------------------------------------------------------

export const SHAPE_TO_TYPE: Record<string, string> = {
  Mdiamond: "start",
  Msquare: "exit",
  box: "codergen",
  hexagon: "wait.human",
  diamond: "conditional",
  component: "parallel",
  tripleoctagon: "parallel.fan_in",
  parallelogram: "tool",
  house: "stack.manager_loop",
};

/**
 * All handler type names the engine recognizes — includes shape-mapped types
 * plus types registered directly by name (e.g. workspace handlers).
 */
export const KNOWN_HANDLER_TYPES: ReadonlySet<string> = new Set([
  ...Object.values(SHAPE_TO_TYPE),
  "workspace.create",
  "workspace.merge",
  "workspace.cleanup",
]);

// ---------------------------------------------------------------------------
// Context (Section 5.1)
// ---------------------------------------------------------------------------

export class Context {
  private _values: Record<string, unknown> = {};
  private _logs: string[] = [];

  set(key: string, value: unknown): void {
    this._values[key] = value;
  }

  get(key: string, defaultVal: unknown = undefined): unknown {
    return this._values[key] ?? defaultVal;
  }

  getString(key: string, defaultVal = ""): string {
    const value = this.get(key);
    if (value == null) return defaultVal;
    return String(value);
  }

  /** Retrieve a value expected to be a `string[]`, returning `defaultVal` if absent or mistyped. */
  getStringArray(key: string, defaultVal: string[] = []): string[] {
    const value = this.get(key);
    if (!Array.isArray(value)) return defaultVal;
    return value.filter((v): v is string => typeof v === "string");
  }

  /** Append a value to a context key that holds an array, creating it if absent. */
  appendToArray(key: string, value: unknown): void {
    const existing = this._values[key];
    if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      this._values[key] = [value];
    }
  }

  appendLog(entry: string): void {
    this._logs.push(entry);
  }

  snapshot(): Record<string, unknown> {
    return { ...this._values };
  }

  clone(): Context {
    const c = new Context();
    c._values = { ...this._values };
    c._logs = [...this._logs];
    return c;
  }

  applyUpdates(updates: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(updates)) {
      this._values[key] = value;
    }
  }

  get logs(): readonly string[] {
    return this._logs;
  }
}

// ---------------------------------------------------------------------------
// Checkpoint (Section 5.3)
// ---------------------------------------------------------------------------

export type Checkpoint = {
  timestamp: string;
  current_node: string;
  /** If set, resume execution at this node instead of current_node. */
  resume_at?: string;
  /**
   * The resolved next node after edge selection.  When present the engine
   * resumes directly at this node (skipping re-execution of current_node).
   * Absent when the pipeline was cancelled mid-stage before edge selection
   * could run, in which case current_node is re-executed.
   */
  next_node?: string;
  completed_nodes: string[];
  node_retries: Record<string, number>;
  context_values: Record<string, unknown>;
  logs: string[];
};

// ---------------------------------------------------------------------------
// Events (Section 9.6)
// ---------------------------------------------------------------------------

export type PipelineEventKind =
  | "pipeline_started"
  | "pipeline_resumed"
  | "pipeline_completed"
  | "pipeline_failed"
  | "pipeline_cancelled"
  | "stage_started"
  | "stage_completed"
  | "stage_failed"
  | "stage_retrying"
  | "checkpoint_saved"
  | "interview_started"
  | "interview_completed"
  | "interview_timeout"
  | "usage_update"
  | "agent_text"
  | "agent_tool_start"
  | "agent_tool_update"
  | "agent_tool_end";

export type PipelineEvent = {
  kind: PipelineEventKind;
  timestamp: string;
  data: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Diagnostics (Section 7.1)
// ---------------------------------------------------------------------------

export type Severity = "error" | "warning" | "info";

export type Diagnostic = {
  rule: string;
  severity: Severity;
  message: string;
  node_id?: string;
  edge?: [string, string];
  fix?: string;
};

// ---------------------------------------------------------------------------
// Interviewer (Section 6)
// ---------------------------------------------------------------------------

export type QuestionType = "yes_no" | "multiple_choice" | "freeform" | "confirmation";

export type Option = {
  key: string;
  label: string;
};

export type Question = {
  text: string;
  /** Optional markdown content to display before collecting an answer. */
  details_markdown?: string;
  type: QuestionType;
  options: Option[];
  default_answer?: Answer;
  timeout_seconds?: number;
  stage: string;
};

export type AnswerValue = "yes" | "no" | "skipped" | "timeout";

export type Answer = {
  value: string | AnswerValue;
  selected_option?: Option;
  text?: string;
};

export interface Interviewer {
  ask(question: Question): Promise<Answer>;
}

// ---------------------------------------------------------------------------
// Human-gate context keys
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Review findings accumulation
// ---------------------------------------------------------------------------

/** A single review finding captured from a review or tool stage. */
export type ReviewFinding = {
  /** The stage node ID that produced this finding. */
  stageId: string;
  /** The iteration number (1-indexed) — increments each time the stage runs. */
  iteration: number;
  /** Status the stage produced (fail, partial_success). */
  status: StageStatus;
  /** The failure reason extracted from the outcome. */
  failureReason: string;
  /** Full response text containing the detailed findings. */
  response: string;
  /** ISO timestamp when the finding was recorded. */
  timestamp: string;
};

/** Well-known context key for accumulated review findings. */
export const REVIEW_FINDINGS_KEY = "review.findings" as const;

// ---------------------------------------------------------------------------
// Human-gate context keys
// ---------------------------------------------------------------------------

/** Well-known context keys written by the human-gate handler and read by the engine. */
export const HUMAN_GATE_KEYS = {
  /** The option key chosen by the human reviewer. */
  SELECTED: "human.gate.selected",
  /** The label of the chosen option. */
  LABEL: "human.gate.label",
  /** Free-form feedback text supplied during review. */
  FEEDBACK: "human.gate.feedback",
  /** Path to the draft file shown during review. */
  DRAFT_PATH: "human.gate.draft_path",
  /**
   * Map of gate-scoped pending re-reviews.
   *
   * Value is a `PendingReReviews` record: gate node ID → approve-target
   * node IDs.  Each entry means "the reviewer chose Revise at this gate;
   * redirect back here if execution tries to reach one of these targets."
   *
   * The handler adds/removes its own entry; the engine checks all entries.
   */
  PENDING_RE_REVIEWS: "human.gate.pending_re_reviews",
} as const;

/**
 * Per-gate re-review state stored under `HUMAN_GATE_KEYS.PENDING_RE_REVIEWS`.
 * Keys are human-gate node IDs; values are the approve-target node IDs that
 * should trigger a redirect back to that gate.
 */
export type PendingReReviews = Record<string, string[]>;

// ---------------------------------------------------------------------------
// CodergenBackend (Section 4.5)
// ---------------------------------------------------------------------------

/** Options passed to backend run calls. */
export type BackendRunOptions = {
  signal?: AbortSignal;
};

export interface CodergenBackend {
  run(node: GraphNode, prompt: string, context: Context, options?: BackendRunOptions): Promise<string | Outcome>;
}

// ---------------------------------------------------------------------------
// Usage metrics (Section 9.7 — CLI telemetry)
// ---------------------------------------------------------------------------

/** Token and cost metrics for a single stage attempt. */
export type UsageMetrics = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cost: number;
};

/** Usage for a single completed stage attempt. */
export type StageAttemptUsage = {
  stageId: string;
  attempt: number;
  metrics: UsageMetrics;
};

/** Aggregated usage summary for a pipeline run. */
export type RunUsageSummary = {
  /** Per-stage-attempt breakdown (all completed attempts in scope). */
  stages: StageAttemptUsage[];
  /** Aggregated totals across all attempts in this invocation. */
  totals: UsageMetrics;
};

/** Streaming usage update event payload. */
export type UsageUpdatePayload = {
  stageId: string;
  attempt: number;
  /** Snapshot of current metrics for this stage attempt. */
  metrics: UsageMetrics;
  /** Running summary across all attempts so far. */
  summary: RunUsageSummary;
};
