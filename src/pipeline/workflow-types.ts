import type { Severity, Diagnostic } from "./types.js";

export type WorkflowStageKind =
  | "exit"
  | "llm"
  | "tool"
  | "human"
  | "decision"
  | "workspace.create"
  | "workspace.merge"
  | "workspace.cleanup";

export type WorkflowRetry = {
  max_attempts: number;
  backoff?: "none" | "fixed" | "exponential";
  delay?: string;
  max_delay?: string;
};

export type WorkflowModelProfile = {
  model?: string;
  provider?: string;
  reasoning_effort?: string;
};

export type WorkflowModels = {
  default?: string;
  profile?: Record<string, WorkflowModelProfile>;
};

export type WorkflowBaseStage = {
  id: string;
  kind: WorkflowStageKind;
  retry?: WorkflowRetry;
  model_profile?: string;
};

export type WorkflowLlmStage = WorkflowBaseStage & {
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

export type WorkflowToolStage = WorkflowBaseStage & {
  kind: "tool";
  command: string;
  cwd?: string;
  timeout?: string;
};

export type WorkflowHumanOption = {
  key: string;
  label: string;
  to: string;
};

export type WorkflowHumanStage = WorkflowBaseStage & {
  kind: "human";
  prompt: string;
  options: WorkflowHumanOption[];
  require_feedback_on?: string[];
  details_from?: string;
  re_review?: boolean;
};

export type WorkflowDecisionRoute = {
  when: string;
  to: string;
  priority?: number;
};

export type WorkflowDecisionStage = WorkflowBaseStage & {
  kind: "decision";
  routes: WorkflowDecisionRoute[];
};

export type WorkflowExitStage = WorkflowBaseStage & { kind: "exit" };

export type WorkflowWorkspaceStage = WorkflowBaseStage & {
  kind: "workspace.create" | "workspace.merge" | "workspace.cleanup";
  workspace_name?: string;
};

export type WorkflowStage =
  | WorkflowLlmStage
  | WorkflowToolStage
  | WorkflowHumanStage
  | WorkflowDecisionStage
  | WorkflowExitStage
  | WorkflowWorkspaceStage;

export type WorkflowTransition = {
  from: string;
  to: string;
  when?: string;
  priority?: number;
};

export type WorkflowDefinition = {
  version: 2;
  name: string;
  goal?: string;
  start: string;
  models?: WorkflowModels;
  stages: WorkflowStage[];
  transitions?: WorkflowTransition[];
};

/**
 * Workflow-specific diagnostic type. Currently identical to the base
 * `Diagnostic`, but aliased to allow independent evolution (e.g., adding
 * KDL source locations) without changing consumer signatures.
 */
export type WorkflowDiagnostic = Diagnostic;

export function workflowDiag(
  rule: string,
  severity: Severity,
  message: string,
  opts?: { node_id?: string; edge?: [string, string]; fix?: string },
): WorkflowDiagnostic {
  const { node_id, edge, fix } = opts ?? {};
  return { rule, severity, message, node_id, edge, fix };
}
