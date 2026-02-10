/**
 * LLM-backed CodergenBackend — bridges the pipeline engine to real LLM calls.
 *
 * Takes a Client + model configuration and implements the CodergenBackend
 * interface so runPipeline() can use actual language models.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { Client, GenerateOptions, ToolDefinition } from "../llm/index.js";
import { generate } from "../llm/index.js";
import type { CodergenBackend, GraphNode, Outcome, BackendRunOptions } from "./types.js";
import { Context } from "./types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type LlmBackendConfig = {
  /** The LLM client to use. */
  client: Client;

  /** Default model for codergen nodes (can be overridden per-node via llm_model attr). */
  model: string;

  /** Default provider name (can be overridden per-node via llm_provider attr). */
  provider?: string;

  /** System prompt prepended to every codergen call. */
  systemPrompt?: string;

  /** Max tokens for LLM responses. */
  maxTokens?: number;

  /** Temperature (0-1). */
  temperature?: number;

  /** Tools available to the LLM during codergen stages. */
  tools?: ToolDefinition[];

  /** Max tool execution rounds per stage. */
  maxToolRounds?: number;

  /**
   * Custom outcome parser. Given the raw LLM text response and context,
   * produce an Outcome. If not provided, a default parser is used that
   * treats any response as success.
   */
  parseOutcome?: (text: string, node: GraphNode, context: Context) => Outcome;
};

// ---------------------------------------------------------------------------
// Default outcome parser
// ---------------------------------------------------------------------------

/**
 * Default parser: looks for structured signals in the LLM response text.
 * Supports:
 *   - `[STATUS: fail]` or `[STATUS: success]` markers
 *   - `[PREFERRED_LABEL: ...]` for edge routing
 *   - `[NEXT: node_id]` for suggested next nodes
 *
 * Falls back to "success" if no markers found.
 */
function defaultParseOutcome(
  text: string,
  node: GraphNode,
  _context: Context,
): Outcome {
  const outcome: Outcome = {
    status: "success",
    notes: text.slice(0, 500),
    context_updates: {
      [`${node.id}.response`]: text.slice(0, 2000),
    },
  };

  // Status marker
  const statusMatch = text.match(/\[STATUS:\s*(success|fail|partial_success|retry)\]/i);
  if (statusMatch) {
    outcome.status = statusMatch[1].toLowerCase() as Outcome["status"];
  }

  // Preferred label
  const labelMatch = text.match(/\[PREFERRED_LABEL:\s*(.+?)\]/i);
  if (labelMatch) {
    outcome.preferred_label = labelMatch[1].trim();
  }

  // Suggested next IDs
  const nextMatches = [...text.matchAll(/\[NEXT:\s*(\w+)\]/gi)];
  if (nextMatches.length > 0) {
    outcome.suggested_next_ids = nextMatches.map((m) => m[1]);
  }

  // Failure reason
  const failMatch = text.match(/\[FAILURE_REASON:\s*(.+?)\]/i);
  if (failMatch) {
    outcome.failure_reason = failMatch[1].trim();
  } else if (outcome.status === "fail") {
    outcome.failure_reason = text.slice(0, 200);
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// Build context summary for the LLM
// ---------------------------------------------------------------------------

function buildContextSummary(context: Context): string {
  const snapshot = context.snapshot();
  const entries = Object.entries(snapshot)
    .filter(([key]) => !key.startsWith("_"))
    .map(([key, value]) => `  ${key}: ${String(value).slice(0, 200)}`)
    .join("\n");

  let summary = entries ? `Current pipeline context:\n${entries}` : "";

  // If running in a workspace, add explicit instructions
  const wsPath = context.getString("workspace.path");
  if (wsPath) {
    summary += `\n\nYou are working in an isolated jj workspace at: ${wsPath}\n` +
      `All file operations and shell commands should use this directory as the working directory.\n` +
      `Use jj (not git) for version control. Commit incrementally as you work.`;
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Prompt file loading
// ---------------------------------------------------------------------------

/**
 * Resolve a path that may start with `~` to an absolute path.
 */
function expandPath(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return resolve(homedir(), p.slice(2));
  }
  return resolve(p);
}

/**
 * Load and concatenate prompt files referenced by a node's `prompt_file`
 * attribute. Files are comma-separated and joined with `\n\n---\n\n`.
 *
 * Returns empty string if no prompt_file attribute is set.
 */
async function loadPromptFiles(node: GraphNode): Promise<string> {
  const raw = node.attrs.prompt_file as string | undefined;
  if (!raw) return "";

  const paths = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  const sections: string[] = [];
  for (const p of paths) {
    const abs = expandPath(p);
    try {
      const content = await readFile(abs, "utf-8");
      sections.push(content.trim());
    } catch (err) {
      throw new Error(
        `Failed to read prompt_file "${p}" (resolved to ${abs}): ${err}`,
      );
    }
  }

  return sections.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class LlmBackend implements CodergenBackend {
  private _config: LlmBackendConfig;

  constructor(config: LlmBackendConfig) {
    this._config = config;
  }

  async run(
    node: GraphNode,
    prompt: string,
    context: Context,
    _options?: BackendRunOptions,
  ): Promise<Outcome> {
    // Resolve per-node overrides
    const model =
      (node.attrs.llm_model as string) ?? this._config.model;
    const provider =
      (node.attrs.llm_provider as string) ?? this._config.provider;
    const reasoningEffort =
      (node.attrs.reasoning_effort as string) ?? undefined;

    // Load external prompt files and prepend to inline prompt
    const fileContent = await loadPromptFiles(node);
    const combinedPrompt = fileContent
      ? `${fileContent}\n\n---\n\n${prompt}`
      : prompt;

    // Build the full prompt with context
    const contextSummary = buildContextSummary(context);
    const fullPrompt = contextSummary
      ? `${contextSummary}\n\n---\n\n${combinedPrompt}`
      : combinedPrompt;

    // Construct generate options
    const opts: GenerateOptions = {
      model,
      prompt: fullPrompt,
      system: this._config.systemPrompt,
      provider,
      client: this._config.client,
      temperature: this._config.temperature,
      max_tokens: this._config.maxTokens,
      tools: this._config.tools,
      max_tool_rounds: this._config.maxToolRounds ?? 5,
      reasoning_effort: reasoningEffort,
    };

    const result = await generate(opts);

    // Parse outcome
    const parseOutcome =
      this._config.parseOutcome ?? defaultParseOutcome;
    const outcome = parseOutcome(result.text, node, context);

    // Attach usage metadata
    outcome.context_updates = {
      ...outcome.context_updates,
      [`${node.id}.usage.input_tokens`]: result.total_usage.input_tokens,
      [`${node.id}.usage.output_tokens`]: result.total_usage.output_tokens,
      [`${node.id}.usage.total_tokens`]: result.total_usage.total_tokens,
    };

    return outcome;
  }
}
