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

// ---------------------------------------------------------------------------
// Valid thinking levels
// ---------------------------------------------------------------------------

const VALID_THINKING_LEVELS = new Set<ThinkingLevel>([
  "off", "minimal", "low", "medium", "high", "xhigh",
]);

// Tool name sets for each mode
const CODING_TOOLS = ["bash", "read", "edit", "write", "grep", "find", "ls"];
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

/** Tools considered mutating — if any of these completed, skip-retry is unsafe. */
const MUTATING_TOOLS = new Set(["bash", "edit", "write"]);

// ---------------------------------------------------------------------------
// Skip detection
// ---------------------------------------------------------------------------

/** Text pattern indicating a skipped tool result from pi's infrastructure. */
const SKIP_TEXT_PATTERN = /Skipped due to queued user message/i;

/**
 * Default timeout (ms) for waiting for agent_end after waitForIdle completes.
 * If agent_end hasn't arrived within this window, we treat it as a protocol
 * timeout. 30 seconds is generous — agent_end normally fires within milliseconds.
 */
export const AGENT_END_TIMEOUT_MS = 30_000;

/** Maximum number of automatic protocol-failure retries per run. */
const MAX_PROTOCOL_RETRIES = 1;

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

  /**
   * Timeout (ms) for waiting for agent_end after waitForIdle completes.
   * @default AGENT_END_TIMEOUT_MS (30_000)
   */
  agentEndTimeoutMs?: number;
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
// Agent message content block helpers
// ---------------------------------------------------------------------------

/**
 * Loosely-typed content block — covers text, tool_use, and tool_result
 * shapes that appear inside `AgentMessage.content` arrays.
 *
 * We keep one shared interface so the defensive narrowing cast lives in a
 * single auditable place (`getContentBlocks`), rather than scattered across
 * every function that inspects message content.
 */
interface ContentBlock {
  type: string;
  text?: string;
  content?: string;
  name?: string;
  id?: string;
}

/**
 * Safely extract the content blocks from an `AgentMessage`.
 * Returns an empty array for non-object messages or messages without a
 * `content` array.
 */
function getContentBlocks(msg: AgentMessage): ContentBlock[] {
  if (typeof msg !== "object" || msg === null || !("role" in msg)) return [];
  if (!("content" in msg) || !Array.isArray((msg as { content: unknown[] }).content)) return [];
  return (msg as { content: ContentBlock[] }).content;
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
// Skip / mutating-tool detection in agent messages
// ---------------------------------------------------------------------------

/**
 * Scan all messages for text matching the skip pattern.
 * Returns true if any message content (text blocks, tool results) contains
 * the skip indicator.
 */
export function detectSkippedToolResults(messages: AgentMessage[]): boolean {
  for (const msg of messages) {
    for (const block of getContentBlocks(msg)) {
      if (block.type === "text" && typeof block.text === "string" && SKIP_TEXT_PATTERN.test(block.text)) {
        return true;
      }
      // Tool result blocks may have a content or text field
      if (block.type === "tool_result" && typeof block.content === "string" && SKIP_TEXT_PATTERN.test(block.content)) {
        return true;
      }
      if (block.type === "tool_result" && typeof block.text === "string" && SKIP_TEXT_PATTERN.test(block.text)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check if any mutating tool (bash, edit, write) was invoked in the messages.
 * This is used to decide whether auto-retry after a skip is safe.
 */
export function detectMutatingToolUse(messages: AgentMessage[]): boolean {
  for (const msg of messages) {
    for (const block of getContentBlocks(msg)) {
      if (block.type === "tool_use" && typeof block.name === "string" && MUTATING_TOOLS.has(block.name)) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Dispatch result (return type of _dispatchOnce)
// ---------------------------------------------------------------------------

/** Result of a single prompt dispatch cycle. */
type DispatchResult = {
  cancelled: boolean;
  cancelReason?: string;
  responseText: string;
  messages?: AgentMessage[];
};

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
      this._ensureHandlersRegistered(pi);

      // -- Dispatch with protocol retry logic --------------------------------
      const outcome = await this._dispatchWithRetry(
        pi, ctx, runToken, node, fullPrompt, context, signal,
      );
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

  /**
   * Send the prompt and wait for completion, with protocol-failure retry.
   * Retries at most once for transient failures (skip, empty response) when
   * no mutating tool side effects were observed.
   */
  private async _dispatchWithRetry(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    runToken: symbol,
    node: GraphNode,
    fullPrompt: string,
    context: Context,
    signal: AbortSignal | undefined,
  ): Promise<Outcome> {
    let lastOutcome: Outcome | undefined;

    for (let attempt = 0; attempt <= MAX_PROTOCOL_RETRIES; attempt++) {
      const result = await this._dispatchOnce(pi, ctx, runToken, fullPrompt, signal);

      if (result.cancelled) {
        return {
          status: "cancelled",
          failure_reason: result.cancelReason ?? "Cancelled during execution",
        };
      }

      // -- Parse outcome ---------------------------------------------------
      const parseOutcome = this._config.parseOutcome ?? defaultParseOutcome;
      const outcome = parseOutcome(result.responseText, node, context);

      const keyBase = getResponseKeyBase(node);
      outcome.context_updates = {
        ...outcome.context_updates,
        [`${keyBase}._full_response`]: result.responseText,
      };

      // -- Check for skip-protocol failures --------------------------------
      const hasSkips = result.messages
        ? detectSkippedToolResults(result.messages)
        : false;
      const hasMutating = result.messages
        ? detectMutatingToolUse(result.messages)
        : false;

      if (hasSkips) {
        if (hasMutating) {
          // Unsafe to retry — mutating tools may have partially executed
          return {
            status: "fail",
            failure_reason:
              "Tool results were skipped after mutating tool side effects; " +
              "cannot safely auto-retry. Manual review required.",
            failure_class: "tool_result_skipped",
            context_updates: outcome.context_updates,
          };
        }

        if (attempt < MAX_PROTOCOL_RETRIES) {
          context.appendLog(
            `[PiNativeBackend] Detected skipped tool results on attempt ${attempt + 1}; ` +
            `retrying (no mutating side effects detected).`,
          );
          continue; // retry
        }

        // Exhausted retries — return explicit skip failure
        return {
          status: "fail",
          failure_reason:
            "Tool results were skipped (queued user message) and retry was exhausted.",
          failure_class: "tool_result_skipped",
          context_updates: outcome.context_updates,
        };
      }

      // -- Check for protocol failures eligible for retry ------------------
      const isProtocolFailure = outcome.failure_class === "missing_status_marker" ||
        outcome.failure_class === "empty_response";

      if (isProtocolFailure && attempt < MAX_PROTOCOL_RETRIES && !hasMutating) {
        context.appendLog(
          `[PiNativeBackend] Protocol failure (${outcome.failure_class}) on attempt ${attempt + 1}; ` +
          `retrying.`,
        );
        continue; // retry
      }

      lastOutcome = outcome;
      break;
    }

    // Defensive: should be unreachable — every code path either returns
    // early or sets lastOutcome before breaking.
    if (!lastOutcome) {
      return {
        status: "fail",
        failure_reason: "Protocol retry loop exited without producing an outcome",
        failure_class: "empty_response",
      };
    }
    return lastOutcome;
  }

  /**
   * Perform a single send-and-wait cycle. Returns the captured messages
   * and extracted response text, or a cancellation indicator.
   */
  private async _dispatchOnce(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    runToken: symbol,
    fullPrompt: string,
    signal: AbortSignal | undefined,
  ): Promise<DispatchResult> {
    // Reset handler state for this attempt. Safe across retries because:
    // - The runToken check in the agent_end handler gates cross-attempt events
    // - The new agentEndResolve/capturedMessages replace the previous attempt's
    //   locals before waitForIdle dispatches the next prompt
    this._activeRunToken = runToken;
    this._systemPromptOverride = this._config.systemPrompt;

    let capturedMessages: AgentMessage[] | undefined;
    let agentEndResolve: (() => void) | undefined;
    const agentEndPromise = new Promise<void>((resolve) => {
      agentEndResolve = resolve;
    });

    this._onAgentEndForActiveRun = (event) => {
      if (this._activeRunToken !== runToken) {
        return;
      }
      capturedMessages = event.messages;
      agentEndResolve?.();
    };

    // -- Set up abort handling ---------------------------------------------
    let abortHandler: (() => void) | undefined;
    if (signal) {
      abortHandler = () => {
        ctx.abort();
        agentEndResolve?.(); // unblock waiting
      };
      signal.addEventListener("abort", abortHandler, { once: true });
      if (signal.aborted) {
        signal.removeEventListener("abort", abortHandler);
        return { cancelled: true, cancelReason: "Cancelled before prompt dispatch", responseText: "" };
      }
    }

    try {
      // -- Send prompt through pi's agent ----------------------------------
      await ctx.waitForIdle();
      await Promise.resolve(pi.sendUserMessage(fullPrompt, { deliverAs: "followUp" }));
      await ctx.waitForIdle();

      // -- Completion latch: wait for agent_end if not yet captured ---------
      if (!capturedMessages) {
        const timeoutMs = this._config.agentEndTimeoutMs ?? AGENT_END_TIMEOUT_MS;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<"timeout">((resolve) => {
          timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
        });

        const result = await Promise.race([
          agentEndPromise.then(() => "resolved" as const),
          timeoutPromise,
        ]);

        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);

        if (result === "timeout" && !capturedMessages) {
          return {
            cancelled: false,
            responseText: "",
            messages: undefined,
          };
        }
      }
    } finally {
      if (abortHandler) {
        signal!.removeEventListener("abort", abortHandler);
      }
    }

    // Check cancellation
    if (signal?.aborted) {
      return { cancelled: true, cancelReason: "Cancelled during execution", responseText: "" };
    }

    const responseText = capturedMessages
      ? extractAssistantText(capturedMessages)
      : "";

    return {
      cancelled: false,
      responseText,
      messages: capturedMessages,
    };
  }
}
