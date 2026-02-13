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

// DOT Parser
export { parseDot } from "./dot-parser.js";

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

// AWF2 (KDL workflow format v2)
export type {
  Awf2Workflow,
  Awf2Stage,
  Awf2StageKind,
  Awf2LlmStage,
  Awf2ToolStage,
  Awf2HumanStage,
  Awf2DecisionStage,
  Awf2ExitStage,
  Awf2WorkspaceStage,
  Awf2HumanOption,
  Awf2DecisionRoute,
  Awf2Transition,
  Awf2Retry,
  Awf2Models,
  Awf2ModelProfile,
  Awf2Diagnostic,
} from "./awf2-types.js";
export { validateAwf2, validateAwf2OrRaise } from "./awf2-validator.js";

// Pi SDK Backend
export { PiBackend } from "../pi-backend.js";
export type { PiBackendConfig } from "../pi-backend.js";

// Re-export ToolMode for CLI
export type { ToolMode } from "../pi-backend.js";
