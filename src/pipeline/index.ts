/**
 * Attractor Pipeline Engine — public API.
 */

// Types
export type {
  Graph, GraphNode, GraphEdge, GraphAttrs, NodeAttrs, EdgeAttrs,
  StageStatus, Outcome, Handler,
  Checkpoint,
  PipelineEvent, PipelineEventKind,
  Diagnostic, Severity,
  Question, QuestionType, Option, Answer, AnswerValue, Interviewer,
  CodergenBackend,
} from "./types.js";

export { Context, SHAPE_TO_TYPE } from "./types.js";

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
export type { PipelineConfig, PipelineResult } from "./engine.js";

// Interviewers
export {
  AutoApproveInterviewer, QueueInterviewer,
  CallbackInterviewer, RecordingInterviewer,
} from "./interviewers.js";

// Stylesheet
export { applyStylesheet, parseStylesheet } from "./stylesheet.js";

// LLM Backend
export { LlmBackend } from "./llm-backend.js";
export type { LlmBackendConfig } from "./llm-backend.js";
