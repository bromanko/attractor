/**
 * Anthropic Provider Profile — configures the coding agent loop for
 * Claude models with Anthropic's tool-use conventions.
 */

import type { ToolDefinition } from "../../llm/index.js";
import type { ProviderProfile, ToolRegistry, ExecutionEnvironment } from "../types.js";
import { createToolRegistry, CORE_TOOLS } from "../tools.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type AnthropicProfileConfig = {
  /** Model ID (e.g., "claude-sonnet-4-5", "claude-opus-4-6"). */
  model?: string;
  /** Context window size (default: 200000). */
  contextWindow?: number;
  /** Additional custom tools to register. */
  extraTools?: Array<{ definition: ToolDefinition; executor: (args: Record<string, unknown>, env: ExecutionEnvironment) => Promise<string> }>;
  /** Additional system prompt content appended after the base prompt. */
  extraSystemPrompt?: string;
};

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(
  env: ExecutionEnvironment,
  extraPrompt?: string,
  projectDocs?: string,
): string {
  const parts: string[] = [];

  parts.push(
    `You are an expert coding assistant. You help users by reading files, ` +
    `executing commands, editing code, and writing new files.`,
  );

  parts.push(
    `\nEnvironment:` +
    `\n- Working directory: ${env.working_directory()}` +
    `\n- Platform: ${env.platform()}`,
  );

  parts.push(
    `\nGuidelines:` +
    `\n- Read files before editing to understand context` +
    `\n- Use shell for operations like ls, find, grep when exploring` +
    `\n- Use edit_file for precise changes (old text must match exactly)` +
    `\n- Use write_file only for new files or complete rewrites` +
    `\n- Be concise and direct`,
  );

  if (projectDocs) {
    parts.push(`\nProject documentation:\n${projectDocs}`);
  }

  if (extraPrompt) {
    parts.push(`\n${extraPrompt}`);
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Profile implementation
// ---------------------------------------------------------------------------

export class AnthropicProfile implements ProviderProfile {
  readonly id = "anthropic";
  readonly model: string;
  readonly tool_registry: ToolRegistry;
  readonly supports_reasoning = true;
  readonly supports_streaming = true;
  readonly supports_parallel_tool_calls = true;
  readonly context_window_size: number;

  private _extraSystemPrompt?: string;

  constructor(config: AnthropicProfileConfig = {}) {
    this.model = config.model ?? "claude-sonnet-4-5";
    this.context_window_size = config.contextWindow ?? 200_000;
    this._extraSystemPrompt = config.extraSystemPrompt;

    // Register core tools
    this.tool_registry = createToolRegistry();
    for (const tool of CORE_TOOLS) {
      this.tool_registry.register(tool);
    }

    // Register extra tools
    if (config.extraTools) {
      for (const tool of config.extraTools) {
        this.tool_registry.register(tool);
      }
    }
  }

  build_system_prompt(
    environment: ExecutionEnvironment,
    projectDocs?: string,
  ): string {
    return buildSystemPrompt(
      environment,
      this._extraSystemPrompt,
      projectDocs,
    );
  }

  tools(): ToolDefinition[] {
    return this.tool_registry.definitions();
  }

  provider_options(): Record<string, unknown> {
    return {};
  }
}
