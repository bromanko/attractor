/**
 * Attractor Pipeline Engine — public API.
 */

// Types
export type {
  Graph, GraphNode, GraphEdge, GraphAttrs, NodeAttrs, EdgeAttrs,
  StageStatus, Outcome, Handler, ToolStageFailure,
  Checkpoint,
  PipelineEvent, PipelineEventKind,
  Diagnostic, Severity,
  Question, QuestionType, Option, Answer, AnswerValue, Interviewer,
  CodergenBackend, BackendRunOptions,
  UsageMetrics, StageAttemptUsage, RunUsageSummary, UsageUpdatePayload,
} from "./types.js";

export { Context, SHAPE_TO_TYPE, KNOWN_HANDLER_TYPES } from "./types.js";

// Validator
export { validate, validateOrRaise, findStartNode, findExitNodes } from "./validator.js";

// Conditions
export { evaluateCondition, parseCondition } from "./conditions.js";

// Handlers
export {
  StartHandler, ExitHandler, CodergenHandler,
  WaitForHumanHandler, ConditionalHandler, ToolHandler,
  HandlerRegistry,
} from "./handlers.js";

// Workspace
export {
  WorkspaceCreateHandler, WorkspaceMergeHandler, WorkspaceCleanupHandler,
  emergencyWorkspaceCleanup, WS_CONTEXT,
} from "./workspace.js";
export type { JjRunner } from "./workspace.js";

// Engine
export { runPipeline } from "./engine.js";
export type { PipelineConfig, PipelineResult, PipelineFailureSummary  } from "./engine.js";

// Interviewers
export {
  AutoApproveInterviewer, QueueInterviewer,
  CallbackInterviewer, RecordingInterviewer,
} from "./interviewers.js";

// Tool failure diagnostics
export {
  classifyFailure, extractTail, buildDigest,
  extractFirstFailingCheck, extractSelfciDigest, isSelfciCommand,
} from "./tool-failure.js";
export type { ToolFailureClass, ToolFailureDetails } from "./tool-failure.js";

// Stylesheet
export { applyStylesheet, parseStylesheet } from "./stylesheet.js";

// KDL workflow format
export type {
  Awf2Workflow as WorkflowDefinition,
  Awf2Stage as WorkflowStage,
  Awf2StageKind as WorkflowStageKind,
  Awf2LlmStage as LlmWorkflowStage,
  Awf2ToolStage as ToolWorkflowStage,
  Awf2HumanStage as HumanWorkflowStage,
  Awf2DecisionStage as DecisionWorkflowStage,
  Awf2ExitStage as ExitWorkflowStage,
  Awf2WorkspaceStage as WorkspaceWorkflowStage,
  Awf2HumanOption as HumanOption,
  Awf2DecisionRoute as DecisionRoute,
  Awf2Transition as WorkflowTransition,
  Awf2Retry as RetryPolicy,
  Awf2Models as WorkflowModels,
  Awf2ModelProfile as WorkflowModelProfile,
  Awf2Diagnostic as WorkflowDiagnostic,
} from "./awf2-types.js";
export { validateWorkflow, validateWorkflowOrRaise } from "./awf2-validator.js";
export { parseWorkflowKdl } from "./awf2-kdl-parser.js";
export { parseWorkflowDefinition, workflowToGraph, parseWorkflowToGraph } from "./awf2-loader.js";

// Pi SDK Backend
export { PiBackend } from "../pi-backend.js";
export type { PiBackendConfig } from "../pi-backend.js";

// Re-export ToolMode for CLI
export type { ToolMode } from "../pi-backend.js";
