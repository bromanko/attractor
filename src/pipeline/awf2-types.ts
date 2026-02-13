import type { Severity, Diagnostic } from "./types.js";

export type Awf2StageKind =
  | "exit"
  | "llm"
  | "tool"
  | "human"
  | "decision"
  | "workspace.create"
  | "workspace.merge"
  | "workspace.cleanup";

export type Awf2Retry = {
  max_attempts: number;
  backoff?: "none" | "fixed" | "exponential";
  delay?: string;
  max_delay?: string;
};

export type Awf2ModelProfile = {
  model?: string;
  provider?: string;
  reasoning_effort?: string;
};

export type Awf2Models = {
  default?: string;
  profile?: Record<string, Awf2ModelProfile>;
};

export type Awf2BaseStage = {
  id: string;
  kind: Awf2StageKind;
  retry?: Awf2Retry;
  model_profile?: string;
};

export type Awf2LlmStage = Awf2BaseStage & {
  kind: "llm";
  prompt?: string;
  prompt_file?: string;
  model?: string;
  provider?: string;
  reasoning_effort?: string;
  auto_status?: boolean;
  goal_gate?: boolean;
  response_key_base?: string;
};

export type Awf2ToolStage = Awf2BaseStage & {
  kind: "tool";
  command: string;
  cwd?: string;
  timeout?: string;
};

export type Awf2HumanOption = {
  key: string;
  label: string;
  to: string;
};

export type Awf2HumanStage = Awf2BaseStage & {
  kind: "human";
  prompt: string;
  options: Awf2HumanOption[];
  require_feedback_on?: string[];
  details_from?: string;
  re_review?: boolean;
};

export type Awf2DecisionRoute = {
  when: string;
  to: string;
  priority?: number;
};

export type Awf2DecisionStage = Awf2BaseStage & {
  kind: "decision";
  routes: Awf2DecisionRoute[];
};

export type Awf2ExitStage = Awf2BaseStage & { kind: "exit" };

export type Awf2WorkspaceStage = Awf2BaseStage & {
  kind: "workspace.create" | "workspace.merge" | "workspace.cleanup";
  workspace_name?: string;
};

export type Awf2Stage =
  | Awf2LlmStage
  | Awf2ToolStage
  | Awf2HumanStage
  | Awf2DecisionStage
  | Awf2ExitStage
  | Awf2WorkspaceStage;

export type Awf2Transition = {
  from: string;
  to: string;
  when?: string;
  priority?: number;
};

export type Awf2Workflow = {
  version: 2;
  name: string;
  goal?: string;
  start: string;
  models?: Awf2Models;
  stages: Awf2Stage[];
  transitions?: Awf2Transition[];
};

/**
 * AWF2-specific diagnostic type. Currently identical to the base `Diagnostic`,
 * but aliased to allow independent evolution (e.g., adding KDL source
 * locations) without changing AWF2 consumer signatures.
 */
export type Awf2Diagnostic = Diagnostic;

export function awf2Diag(
  rule: string,
  severity: Severity,
  message: string,
  opts?: { node_id?: string; edge?: [string, string]; fix?: string },
): Awf2Diagnostic {
  const { node_id, edge, fix } = opts ?? {};
  return { rule, severity, message, node_id, edge, fix };
}
