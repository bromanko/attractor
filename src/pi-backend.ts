/**
 * PiBackend — CodergenBackend implementation powered by the pi SDK.
 *
 * Replaces the old LlmBackend, delegating all LLM interaction to
 * pi's AgentSession (createAgentSession).
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";

import {
  createAgentSession,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  codingTools,
  readOnlyTools,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";

import type { Model, Api } from "@mariozechner/pi-ai";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

import type { CodergenBackend, GraphNode, Outcome, BackendRunOptions, ReviewFinding } from "./pipeline/types.js";
import { Context, REVIEW_FINDINGS_KEY } from "./pipeline/types.js";
import { shouldParseStatusMarkers } from "./pipeline/status-markers.js";

// ---------------------------------------------------------------------------
// Valid thinking levels
// ---------------------------------------------------------------------------

const VALID_THINKING_LEVELS = new Set<ThinkingLevel>([
  "off", "minimal", "low", "medium", "high", "xhigh",
]);

// ---------------------------------------------------------------------------
// Tool mode
// ---------------------------------------------------------------------------

export type ToolMode = "none" | "read-only" | "coding";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type PiBackendConfig = {
  /** Default model ID for codergen nodes (can be overridden per-node via llm_model attr). */
  model: string;

  /** Default provider name (can be overridden per-node via llm_provider attr). */
  provider: string;

  /** Working directory for agent sessions. */
  cwd: string;

  /** System prompt prepended to every codergen call. */
  systemPrompt?: string;

  /** Auth storage for credentials. */
  authStorage?: AuthStorage;

  /** Model registry for model resolution. */
  modelRegistry?: ModelRegistry;

  /**
   * Callback for streaming agent events per node.
   * Receives the executing node's ID and each pi agent session event.
   */
  onStageEvent?: (nodeId: string, event: AgentSessionEvent) => void;

  /**
   * Custom outcome parser. Given the raw LLM text response and context,
   * produce an Outcome. If not provided, the default marker-based parser is used.
   */
  parseOutcome?: (text: string, node: GraphNode, context: Context) => Outcome;

  /**
   * Tool mode controlling which tools are available to the agent.
   * - "none"      — no tools
   * - "read-only" — read, grep, find, ls
   * - "coding"    — read, bash, edit, write (default)
   */
  toolMode?: ToolMode;

  /**
   * @internal — override for testing. Replaces createAgentSession().
   */
  _sessionFactory?: (opts: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
};

// ---------------------------------------------------------------------------
// Default outcome parser (marker protocol)
// ---------------------------------------------------------------------------

/**
 * Default parser: looks for structured signals in the LLM response text.
 * Supports:
 *   - `[STATUS: fail]` or `[STATUS: success]` markers
 *   - `[PREFERRED_LABEL: ...]` for edge routing
 *   - `[NEXT: node_id]` for suggested next nodes
 *   - `[FAILURE_REASON: ...]` for failure descriptions
 *
 * Falls back to "success" if no markers found.
 */
function getResponseKeyBase(node: GraphNode): string {
  const raw = node.attrs.response_key_base;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  return node.id;
}

export function defaultParseOutcome(
  text: string,
  node: GraphNode,
  _context: Context,
): Outcome {
  const keyBase = getResponseKeyBase(node);
  const outcome: Outcome = {
    status: "success",
    notes: text.slice(0, 500),
    context_updates: {
      [`${keyBase}.response`]: text.slice(0, 2000),
    },
  };

  // Status marker — only honoured when the node opts in (see shouldParseStatusMarkers).
  // Use the LAST marker in the response (more robust when models include
  // examples or references to markers earlier in their output).
  const statusMatches = [
    ...text.matchAll(/\[STATUS:\s*(success|fail|partial_success|retry)\]/gi),
  ];
  const statusMatch = statusMatches.length > 0
    ? statusMatches[statusMatches.length - 1]
    : null;
  const shouldParseStatus = shouldParseStatusMarkers(node);
  const requiresStatusMarker = node.attrs.auto_status === true || node.attrs.auto_status === "true";

  if (statusMatch && shouldParseStatus) {
    outcome.status = statusMatch[1].toLowerCase() as Outcome["status"];
  } else if (requiresStatusMarker) {
    outcome.status = "fail";
    outcome.failure_reason = "Missing [STATUS: ...] marker in response";
    outcome.failure_class = text.trim().length === 0
      ? "empty_response"
      : "missing_status_marker";
  } else if (text.trim().length === 0) {
    // Empty response from a non-auto-status codergen node.  The LLM session
    // ended without producing any text (e.g. it exhausted its tool-call
    // budget while still reading files).  Treating this as success would
    // propagate an empty result to downstream stages — fail with a retry
    // hint so the engine can re-attempt the stage.
    outcome.status = "retry";
    outcome.failure_reason = "LLM session produced an empty response";
    outcome.failure_class = "empty_response";
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

  // Failure reason — only parsed when status markers are honoured.
  if (shouldParseStatus) {
    const failMatch = text.match(/\[FAILURE_REASON:\s*(.+?)\]/i);
    if (failMatch) {
      outcome.failure_reason = failMatch[1].trim();
    } else if (outcome.status === "fail" && !outcome.failure_reason) {
      outcome.failure_reason = text.slice(0, 200) || "Stage failed with no response";
    }
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// Context summary builder
// ---------------------------------------------------------------------------

export function buildContextSummary(context: Context): string {
  const snapshot = context.snapshot();

  // Keys containing responses or feedback get generous room so downstream
  // stages can act on detailed upstream feedback.  Everything else (usage
  // stats, short metadata) gets a compact limit.
  const isVerboseKey = (key: string) =>
    key.endsWith(".response") || key.includes("feedback") || key === "graph.goal";

  // Exclude review.findings from generic dump — it gets a dedicated section.
  const entries = Object.entries(snapshot)
    .filter(([key]) => !key.startsWith("_") && key !== REVIEW_FINDINGS_KEY)
    .map(([key, value]) => {
      const limit = isVerboseKey(key) ? 4000 : 200;
      const text = String(value);
      const display = text.length > limit ? text.slice(0, limit) + "…" : text;
      return `  ${key}: ${display}`;
    })
    .join("\n");

  let summary = entries ? `Current pipeline context:\n${entries}` : "";

  // Render accumulated review findings as a structured section
  const findings = snapshot[REVIEW_FINDINGS_KEY];
  if (Array.isArray(findings) && findings.length > 0) {
    summary += "\n\n## Outstanding Review Findings\n\n";
    for (const f of findings as ReviewFinding[]) {
      summary += `### ${f.stageId} (${f.status})\n`;
      summary += `**Reason:** ${f.failureReason}\n\n`;
      summary += f.response + "\n\n---\n\n";
    }
  }

  // If running in a workspace, add explicit instructions
  const wsPath = context.getString("workspace.path");
  if (wsPath) {
    summary +=
      `\n\nYou are working in an isolated jj workspace at: ${wsPath}\n` +
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
export function expandPath(p: string): string {
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
export async function loadPromptFiles(node: GraphNode): Promise<string> {
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

export class PiBackend implements CodergenBackend {
  private _config: PiBackendConfig;

  constructor(config: PiBackendConfig) {
    this._config = config;
  }

  async run(
    node: GraphNode,
    prompt: string,
    context: Context,
    options?: BackendRunOptions,
  ): Promise<Outcome> {
    // Short-circuit if already aborted
    const signal = options?.signal;
    if (signal?.aborted) {
      return {
        status: "cancelled",
        failure_reason: "Cancelled before execution started",
      };
    }

    // -- 2.1 Model resolution -------------------------------------------
    const provider =
      (node.attrs.llm_provider as string) ?? this._config.provider;
    const modelId =
      (node.attrs.llm_model as string) ?? this._config.model;

    let model: Model<Api> | undefined;

    // Try ModelRegistry first
    if (this._config.modelRegistry) {
      model = this._config.modelRegistry.find(provider, modelId);
    }

    if (!model) {
      // Try dynamic import of getModel as fallback
      try {
        const { getModel } = await import("@mariozechner/pi-ai");
        model = getModel(provider as any, modelId as any);
      } catch (err) {
        // getModel only works for built-in typed models; fall through to model-not-found error
        console.warn(`[PiBackend] getModel fallback failed for ${provider}/${modelId}: ${err}`);
      }
    }

    if (!model) {
      return {
        status: "fail",
        failure_reason: `Model not found: ${provider}/${modelId}`,
      };
    }

    // -- 2.2 Thinking level mapping -------------------------------------
    const rawEffort = node.attrs.reasoning_effort as string | undefined;
    let thinkingLevel: ThinkingLevel | undefined;
    if (rawEffort) {
      if (VALID_THINKING_LEVELS.has(rawEffort as ThinkingLevel)) {
        thinkingLevel = rawEffort as ThinkingLevel;
      } else {
        // Log warning, fall through to undefined (pi defaults to medium)
        console.warn(
          `[PiBackend] Unknown reasoning_effort "${rawEffort}" on node "${node.id}", using default`,
        );
      }
    }

    // -- 2.3 Working directory ------------------------------------------
    const cwd =
      context.getString("workspace.path") || this._config.cwd;

    // -- 2.4 Prompt composition -----------------------------------------
    const fileContent = await loadPromptFiles(node);
    const combinedPrompt = fileContent
      ? `${fileContent}\n\n---\n\n${prompt}`
      : prompt;

    const contextSummary = buildContextSummary(context);
    const fullPrompt = contextSummary
      ? `${contextSummary}\n\n---\n\n${combinedPrompt}`
      : combinedPrompt;

    // -- 2.5 Safe resource loader defaults ------------------------------
    const systemPrompt = this._config.systemPrompt;
    const loader = new DefaultResourceLoader({
      cwd,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      systemPromptOverride: () => systemPrompt,
    });
    await loader.reload();

    // -- 2.6 Tool configuration -----------------------------------------
    const toolMode = this._config.toolMode ?? "coding";
    const tools =
      toolMode === "none"
        ? []
        : toolMode === "read-only"
          ? readOnlyTools
          : codingTools;

    // -- 2.7 Session lifecycle ------------------------------------------
    const sessionManager = SessionManager.inMemory(cwd);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
    });

    const factory =
      this._config._sessionFactory ?? createAgentSession;

    let session: CreateAgentSessionResult["session"] | undefined;

    try {
      const sessionOpts: CreateAgentSessionOptions = {
        cwd,
        model,
        thinkingLevel,
        tools,
        resourceLoader: loader,
        sessionManager,
        settingsManager,
        authStorage: this._config.authStorage,
        modelRegistry: this._config.modelRegistry,
      };

      const result = await factory(sessionOpts);
      session = result.session;

      // Subscribe to events for bridging
      if (this._config.onStageEvent) {
        const nodeId = node.id;
        const onEvent = this._config.onStageEvent;
        session.subscribe((event) => {
          onEvent(nodeId, event);
        });
      }

      // -- Send prompt and wait for completion --------------------------
      // Set up abort listener for in-flight cancellation
      let abortHandler: (() => void) | undefined;
      if (signal) {
        abortHandler = () => {
          try {
            session?.dispose();
          } catch (err) {
            // Best effort — dispose may already have been called
            console.warn(`[PiBackend] dispose on abort failed: ${err}`);
          }
        };
        signal.addEventListener("abort", abortHandler, { once: true });

        // Re-check after registering listener to close the race window
        if (signal.aborted) {
          abortHandler();
          return {
            status: "cancelled",
            failure_reason: "Cancelled before prompt dispatch",
          };
        }
      }

      try {
        await session.prompt(fullPrompt);
      } finally {
        if (abortHandler) {
          signal!.removeEventListener("abort", abortHandler);
        }
      }

      // Check if aborted during prompt
      if (signal?.aborted) {
        return {
          status: "cancelled",
          failure_reason: "Cancelled during execution",
        };
      }

      // -- 2.8 Usage extraction -----------------------------------------
      const stats = session.getSessionStats();
      const usageUpdates: Record<string, unknown> = {
        [`${node.id}.usage.input_tokens`]: stats.tokens.input,
        [`${node.id}.usage.output_tokens`]: stats.tokens.output,
        [`${node.id}.usage.total_tokens`]: stats.tokens.total,
        [`${node.id}.usage.cache_read_tokens`]: stats.tokens.cacheRead,
        [`${node.id}.usage.cache_write_tokens`]: stats.tokens.cacheWrite,
        [`${node.id}.usage.cost`]: stats.cost,
      };

      // -- 2.10 Outcome parsing -----------------------------------------
      const responseText = session.getLastAssistantText() ?? "";

      const parseOutcome =
        this._config.parseOutcome ?? defaultParseOutcome;
      const outcome = parseOutcome(responseText, node, context);

      // Merge usage + full response into context_updates.
      // The parser truncates ${keyBase}.response to 2000 chars for context
      // threading; _full_response preserves the complete text for log files.
      const keyBase = getResponseKeyBase(node);
      outcome.context_updates = {
        ...outcome.context_updates,
        ...usageUpdates,
        [`${keyBase}._full_response`]: responseText,
      };

      return outcome;
    } catch (err) {
      // -- 2.9 Error handling -------------------------------------------
      // Detect cancellation
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
      // Idempotent dispose — may already have been called by abort handler
      try { session?.dispose(); } catch (err) {
        // Idempotent dispose — may already have been called by abort handler
        console.warn(`[PiBackend] dispose in finally failed: ${err}`);
      }
    }
  }
}
