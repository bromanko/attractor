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

// KDL workflow format
export type {
  WorkflowDefinition,
  WorkflowStage,
  WorkflowStageKind,
  WorkflowLlmStage as LlmWorkflowStage,
  WorkflowToolStage as ToolWorkflowStage,
  WorkflowHumanStage as HumanWorkflowStage,
  WorkflowDecisionStage as DecisionWorkflowStage,
  WorkflowExitStage as ExitWorkflowStage,
  WorkflowWorkspaceStage as WorkspaceWorkflowStage,
  WorkflowHumanOption as HumanOption,
  WorkflowDecisionRoute as DecisionRoute,
  WorkflowTransition,
  WorkflowRetry as RetryPolicy,
  WorkflowModels,
  WorkflowModelProfile,
  WorkflowDiagnostic,
} from "./workflow-types.js";
export { validateWorkflow, validateWorkflowOrRaise } from "./workflow-validator.js";
export { parseWorkflowKdl } from "./workflow-kdl-parser.js";
export { parseWorkflowDefinition, workflowToGraph, parseWorkflowToGraph } from "./workflow-loader.js";

// Workflow resolution/discovery
export {
  discoverWorkflows,
  resolveWorkflowPath,
  WorkflowResolutionError,
} from "./workflow-resolution.js";
export type {
  WorkflowEntry,
  WorkflowParser,
  DiscoverOptions,
  DiscoverResult,
  ResolveOptions,
  ResolveResult,
  LocationTier,
} from "./workflow-resolution.js";

// DOT serialization
export { graphToDot } from "./graph-to-dot.js";

export { hasGraphEasy, runGraphEasy } from "./graph-easy.js";

// Pi SDK Backend
export { PiBackend } from "../pi-backend.js";
export type { PiBackendConfig } from "../pi-backend.js";
export { PiNativeBackend } from "../pi-native-backend.js";
export type { PiNativeBackendConfig } from "../pi-native-backend.js";

// Re-export ToolMode for CLI
export type { ToolMode } from "../pi-backend.js";
