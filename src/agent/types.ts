/**
 * Coding Agent Loop — Core types.
 * Implements Section 2 of the Coding Agent Loop Specification.
 */

import type { Client, ToolDefinition, Usage, Response, Message } from "../llm/index.js";

// ---------------------------------------------------------------------------
// 2.1 Session types
// ---------------------------------------------------------------------------

export type SessionState = "idle" | "processing" | "awaiting_input" | "closed";

export type SessionConfig = {
  max_turns: number;
  max_tool_rounds_per_input: number;
  default_command_timeout_ms: number;
  max_command_timeout_ms: number;
  reasoning_effort?: string;
  tool_output_limits: Record<string, number>;
  tool_line_limits: Record<string, number>;
  enable_loop_detection: boolean;
  loop_detection_window: number;
  max_subagent_depth: number;
};

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  max_turns: 0,
  max_tool_rounds_per_input: 200,
  default_command_timeout_ms: 10_000,
  max_command_timeout_ms: 600_000,
  tool_output_limits: {
    read_file: 50_000,
    shell: 30_000,
    grep: 20_000,
    glob: 20_000,
    edit_file: 10_000,
    apply_patch: 10_000,
    write_file: 1_000,
    spawn_agent: 20_000,
  },
  tool_line_limits: {
    shell: 256,
    grep: 200,
    glob: 500,
  },
  enable_loop_detection: true,
  loop_detection_window: 10,
  max_subagent_depth: 1,
};

// ---------------------------------------------------------------------------
// 2.4 Turn types
// ---------------------------------------------------------------------------

export type UserTurn = {
  type: "user";
  content: string;
  timestamp: string;
};

export type AssistantTurn = {
  type: "assistant";
  content: string;
  tool_calls: ToolCallEntry[];
  reasoning?: string;
  usage: Usage;
  response_id?: string;
  timestamp: string;
};

export type ToolResultsTurn = {
  type: "tool_results";
  results: ToolResultEntry[];
  timestamp: string;
};

export type SystemTurn = {
  type: "system";
  content: string;
  timestamp: string;
};

export type SteeringTurn = {
  type: "steering";
  content: string;
  timestamp: string;
};

export type Turn = UserTurn | AssistantTurn | ToolResultsTurn | SystemTurn | SteeringTurn;

export type ToolCallEntry = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ToolResultEntry = {
  tool_call_id: string;
  content: string;
  is_error: boolean;
};

// ---------------------------------------------------------------------------
// 2.9 Events
// ---------------------------------------------------------------------------

export type SessionEventKind =
  | "session_start"
  | "session_end"
  | "user_input"
  | "assistant_text_start"
  | "assistant_text_delta"
  | "assistant_text_end"
  | "tool_call_start"
  | "tool_call_output_delta"
  | "tool_call_end"
  | "steering_injected"
  | "turn_limit"
  | "loop_detection"
  | "error";

export type SessionEvent = {
  kind: SessionEventKind;
  timestamp: string;
  session_id: string;
  data: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// 4.1 Execution environment
// ---------------------------------------------------------------------------

export type ExecResult = {
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
  duration_ms: number;
};

export type DirEntry = {
  name: string;
  is_dir: boolean;
  size?: number;
};

export interface ExecutionEnvironment {
  read_file(path: string, offset?: number, limit?: number): Promise<string>;
  write_file(path: string, content: string): Promise<void>;
  file_exists(path: string): Promise<boolean>;
  list_directory(path: string, depth?: number): Promise<DirEntry[]>;
  exec_command(command: string, timeout_ms: number, working_dir?: string, env_vars?: Record<string, string>): Promise<ExecResult>;
  grep(pattern: string, path: string, options?: { case_insensitive?: boolean; max_results?: number }): Promise<string>;
  glob(pattern: string, path: string): Promise<string[]>;
  working_directory(): string;
  platform(): string;
}

// ---------------------------------------------------------------------------
// 3.2 Provider profile
// ---------------------------------------------------------------------------

export type RegisteredTool = {
  definition: ToolDefinition;
  executor: (args: Record<string, unknown>, env: ExecutionEnvironment) => Promise<string>;
};

export type ToolRegistry = {
  tools: Map<string, RegisteredTool>;
  register(tool: RegisteredTool): void;
  unregister(name: string): void;
  get(name: string): RegisteredTool | undefined;
  definitions(): ToolDefinition[];
};

export interface ProviderProfile {
  readonly id: string;
  readonly model: string;
  readonly tool_registry: ToolRegistry;
  readonly supports_reasoning: boolean;
  readonly supports_streaming: boolean;
  readonly supports_parallel_tool_calls: boolean;
  readonly context_window_size: number;

  build_system_prompt(environment: ExecutionEnvironment, project_docs?: string): string;
  tools(): ToolDefinition[];
  provider_options?(): Record<string, unknown>;
}
