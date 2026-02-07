/**
 * Coding Agent Loop — public API.
 */

// Types
export type {
  SessionConfig, SessionState, SessionEvent, SessionEventKind,
  Turn, UserTurn, AssistantTurn, ToolResultsTurn, SystemTurn, SteeringTurn,
  ToolCallEntry, ToolResultEntry,
  ExecutionEnvironment, ExecResult, DirEntry,
  ProviderProfile, RegisteredTool, ToolRegistry,
} from "./types.js";

export { DEFAULT_SESSION_CONFIG } from "./types.js";

// Session
export { Session } from "./session.js";

// Local environment
export { LocalExecutionEnvironment } from "./local-env.js";

// Tools
export {
  createToolRegistry,
  readFileTool, writeFileTool, editFileTool, shellTool, grepTool, globTool,
  CORE_TOOLS,
} from "./tools.js";

// Truncation
export { truncateToolOutput, truncateChars, truncateLines } from "./truncation.js";

// Profiles
export { AnthropicProfile } from "./profiles/index.js";
export type { AnthropicProfileConfig } from "./profiles/index.js";
