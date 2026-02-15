/**
 * PiNativeBackend — CodergenBackend that drives pi's own agent session.
 *
 * Instead of creating isolated AgentSessions, this backend sends prompts
 * through pi's main agent loop via sendUserMessage() + waitForIdle().
 * All output (streaming text, tool calls, tool results) renders natively
 * in pi's conversation UI with familiar collapsible tool results.
 *
 * Used exclusively from the pi extension. The standalone CLI continues
 * to use PiBackend with isolated sessions.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  AgentEndEvent,
} from "@mariozechner/pi-coding-agent";
import { ModelRegistry } from "@mariozechner/pi-coding-agent";

import type { Model, Api, AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ThinkingLevel, AgentMessage } from "@mariozechner/pi-agent-core";

import type {
  CodergenBackend,
  GraphNode,
  Outcome,
  BackendRunOptions,
} from "./pipeline/types.js";
import { Context } from "./pipeline/types.js";
import { defaultParseOutcome, buildContextSummary, loadPromptFiles } from "./pi-backend.js";
import { shouldParseStatusMarkers } from "./pipeline/status-markers.js";

// ---------------------------------------------------------------------------
// Valid thinking levels
// ---------------------------------------------------------------------------

const VALID_THINKING_LEVELS = new Set<ThinkingLevel>([
  "off", "minimal", "low", "medium", "high", "xhigh",
]);

// Tool name sets for each mode
const CODING_TOOLS = ["bash", "read", "edit", "write", "grep", "find", "ls"];
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface PiNativeBackendConfig {
  /** ExtensionAPI for driving pi's agent. */
  pi: ExtensionAPI;

  /** Command context for waitForIdle, model access, etc. */
  ctx: ExtensionCommandContext;

  /** Default model ID (can be overridden per-node via llm_model attr). */
  model: string;

  /** Default provider name (can be overridden per-node via llm_provider attr). */
  provider: string;

  /** System prompt prepended to every codergen call. */
  systemPrompt?: string;

  /** Model registry for model resolution. */
  modelRegistry?: ModelRegistry;

  /**
   * Custom outcome parser. Given the raw LLM text response and context,
   * produce an Outcome. If not provided, the default marker-based parser is used.
   */
  parseOutcome?: (text: string, node: GraphNode, context: Context) => Outcome;

  /**
   * Tool mode controlling which tools are available to the agent.
   * - "none"      — no tools
   * - "read-only" — read, grep, find, ls
   * - "coding"    — read, bash, edit, write, grep, find, ls (default)
   */
  toolMode?: "none" | "read-only" | "coding";
}

// ---------------------------------------------------------------------------
// Saved state for restore after stage
// ---------------------------------------------------------------------------

interface SavedState {
  model: Model<Api> | undefined;
  tools: string[];
  thinkingLevel: ThinkingLevel;
}

// ---------------------------------------------------------------------------
// Response key base (shared with PiBackend)
// ---------------------------------------------------------------------------

function getResponseKeyBase(node: GraphNode): string {
  const raw = node.attrs.response_key_base;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  return node.id;
}

// ---------------------------------------------------------------------------
// Extract text from agent messages
// ---------------------------------------------------------------------------

function extractAssistantText(messages: AgentMessage[]): string {
  // Walk backwards to find the last assistant message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      typeof msg === "object" &&
      msg !== null &&
      "role" in msg &&
      msg.role === "assistant"
    ) {
      const assistant = msg as AssistantMessage;
      const textParts = assistant.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text);
      return textParts.join("");
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class PiNativeBackend implements CodergenBackend {
  private _config: PiNativeBackendConfig;

  /** Active run token used to gate global extension handlers. */
  private _activeRunToken: symbol | undefined;

  /** Active stage-specific system prompt override (only valid while _activeRunToken is set). */
  private _systemPromptOverride: string | undefined;

  /** Per-run sink for capturing agent_end messages. */
  private _onAgentEndForActiveRun: ((event: AgentEndEvent) => void) | undefined;

  /** Guard so we only register global handlers once (pi.on has no unsubscribe). */
  private _handlersRegistered = false;

  constructor(config: PiNativeBackendConfig) {
    this._config = config;
  }

  private _ensureHandlersRegistered(pi: ExtensionAPI): void {
    if (this._handlersRegistered) {
      return;
    }

    pi.on("before_agent_start", () => {
      if (!this._activeRunToken || !this._systemPromptOverride) {
        return;
      }
      return {
        systemPrompt: this._systemPromptOverride,
      };
    });

    pi.on("agent_end", (event) => {
      if (!this._activeRunToken) {
        return;
      }
      this._onAgentEndForActiveRun?.(event);
    });

    this._handlersRegistered = true;
  }

  async run(
    node: GraphNode,
    prompt: string,
    context: Context,
    options?: BackendRunOptions,
  ): Promise<Outcome> {
    const signal = options?.signal;
    if (signal?.aborted) {
      return {
        status: "cancelled",
        failure_reason: "Cancelled before execution started",
      };
    }

    const { pi, ctx } = this._config;

    // -- Save current pi state ------------------------------------------------
    const saved: SavedState = {
      model: ctx.model,
      tools: pi.getActiveTools(),
      thinkingLevel: pi.getThinkingLevel(),
    };
    const runToken = Symbol("pi-native-backend-run");

    try {
      // -- Configure model for this stage ------------------------------------
      const provider =
        (node.attrs.llm_provider as string) ?? this._config.provider;
      const modelId =
        (node.attrs.llm_model as string) ?? this._config.model;

      let model: Model<Api> | undefined;
      if (this._config.modelRegistry) {
        model = this._config.modelRegistry.find(provider, modelId);
      }
      if (!model) {
        try {
          const { getModel } = await import("@mariozechner/pi-ai");
          model = getModel(provider as Parameters<typeof getModel>[0], modelId as Parameters<typeof getModel>[1]);
        } catch (err) {
          console.warn(`[PiNativeBackend] getModel fallback failed for ${provider}/${modelId}: ${err}`);
        }
      }
      if (model) {
        const success = await pi.setModel(model);
        if (!success) {
          return {
            status: "fail",
            failure_reason: `Failed to set model: ${provider}/${modelId} (no API key?)`,
          };
        }
      } else {
        return {
          status: "fail",
          failure_reason: `Model not found: ${provider}/${modelId}`,
        };
      }

      // -- Configure thinking level -----------------------------------------
      const rawEffort = node.attrs.reasoning_effort as string | undefined;
      if (rawEffort && VALID_THINKING_LEVELS.has(rawEffort as ThinkingLevel)) {
        pi.setThinkingLevel(rawEffort as ThinkingLevel);
      }

      // -- Configure tools ---------------------------------------------------
      const toolMode = this._config.toolMode ?? "coding";
      if (toolMode === "none") {
        pi.setActiveTools([]);
      } else if (toolMode === "read-only") {
        pi.setActiveTools(READ_ONLY_TOOLS);
      } else {
        pi.setActiveTools(CODING_TOOLS);
      }

      // -- Build prompt ------------------------------------------------------
      const fileContent = await loadPromptFiles(node);
      const combinedPrompt = fileContent
        ? `${fileContent}\n\n---\n\n${prompt}`
        : prompt;

      const contextSummary = buildContextSummary(context);
      const fullPrompt = contextSummary
        ? `${contextSummary}\n\n---\n\n${combinedPrompt}`
        : combinedPrompt;

      // -- Register global handlers once and bind per-run state --------------
      // pi.on() has no unsubscribe API, so handlers are installed once and
      // gated by a run token to prevent cross-run contamination.
      this._ensureHandlersRegistered(pi);

      this._activeRunToken = runToken;
      this._systemPromptOverride = this._config.systemPrompt;

      // -- Set up response capture -------------------------------------------
      let capturedMessages: AgentMessage[] | undefined;
      this._onAgentEndForActiveRun = (event) => {
        if (this._activeRunToken !== runToken) {
          return;
        }
        capturedMessages = event.messages;
      };

      // -- Set up abort handling ---------------------------------------------
      let abortHandler: (() => void) | undefined;
      if (signal) {
        abortHandler = () => {
          ctx.abort();
        };
        signal.addEventListener("abort", abortHandler, { once: true });
        if (signal.aborted) {
          return {
            status: "cancelled",
            failure_reason: "Cancelled before prompt dispatch",
          };
        }
      }

      // -- Send prompt through pi's agent ------------------------------------
      // Wait for pi to be idle before sending, then deliver as follow-up.
      // This ensures that if a race leaves pi briefly busy, our prompt queues
      // behind the active turn instead of steering/interruption (which can
      // cause remaining tool calls to be skipped).
      try {
        await ctx.waitForIdle();
        await Promise.resolve(pi.sendUserMessage(fullPrompt, { deliverAs: "followUp" }));
        await ctx.waitForIdle();
      } finally {
        if (abortHandler) {
          signal!.removeEventListener("abort", abortHandler);
        }
      }

      // Check cancellation
      if (signal?.aborted) {
        return {
          status: "cancelled",
          failure_reason: "Cancelled during execution",
        };
      }

      // -- Extract response text ---------------------------------------------
      const responseText = capturedMessages
        ? extractAssistantText(capturedMessages)
        : "";

      // -- Parse outcome -----------------------------------------------------
      const parseOutcome =
        this._config.parseOutcome ?? defaultParseOutcome;
      const outcome = parseOutcome(responseText, node, context);

      // Merge full response into context_updates
      const keyBase = getResponseKeyBase(node);
      outcome.context_updates = {
        ...outcome.context_updates,
        [`${keyBase}._full_response`]: responseText,
      };

      return outcome;
    } catch (err) {
      if (signal?.aborted) {
        return {
          status: "cancelled",
          failure_reason: "Cancelled during execution",
        };
      }
      return {
        status: "fail",
        failure_reason: `LLM error: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      // -- Restore pi state --------------------------------------------------
      try {
        if (saved.model) {
          await pi.setModel(saved.model);
        }
        pi.setActiveTools(saved.tools);
        pi.setThinkingLevel(saved.thinkingLevel);
      } catch (err) {
        console.warn(`[PiNativeBackend] failed to restore pi state: ${err}`);
      }
      if (this._activeRunToken === runToken) {
        this._activeRunToken = undefined;
        this._systemPromptOverride = undefined;
        this._onAgentEndForActiveRun = undefined;
      }
    }
  }
}
