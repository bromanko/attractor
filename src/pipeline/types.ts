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
  auto_status?: boolean;
  allow_partial?: boolean;
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
  model_stylesheet?: string;
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
export type StageStatus = "success" | "fail" | "partial_success" | "retry" | "skipped";

/** The result of executing a node handler. */
export type Outcome = {
  status: StageStatus;
  preferred_label?: string;
  suggested_next_ids?: string[];
  context_updates?: Record<string, unknown>;
  notes?: string;
  failure_reason?: string;
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
  | "pipeline_completed"
  | "pipeline_failed"
  | "stage_started"
  | "stage_completed"
  | "stage_failed"
  | "stage_retrying"
  | "checkpoint_saved"
  | "interview_started"
  | "interview_completed"
  | "interview_timeout";

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
// CodergenBackend (Section 4.5)
// ---------------------------------------------------------------------------

export interface CodergenBackend {
  run(node: GraphNode, prompt: string, context: Context): Promise<string | Outcome>;
}
