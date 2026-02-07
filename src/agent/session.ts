/**
 * Coding Agent Session — Section 2 of the Coding Agent Loop Spec.
 * The core agentic loop: LLM call → tool execution → loop until done.
 */

import type { Client, Message, Response, ToolDefinition, Usage } from "../llm/index.js";
import { Msg, messageText, emptyUsage, addUsage, responseToolCalls } from "../llm/index.js";
import type {
  SessionConfig,
  SessionState,
  SessionEvent,
  SessionEventKind,
  Turn,
  ToolCallEntry,
  ToolResultEntry,
  ExecutionEnvironment,
  ProviderProfile,
} from "./types.js";
import { DEFAULT_SESSION_CONFIG } from "./types.js";
import { truncateToolOutput } from "./truncation.js";

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export class Session {
  readonly id: string;
  private _profile: ProviderProfile;
  private _env: ExecutionEnvironment;
  private _history: Turn[] = [];
  private _config: SessionConfig;
  private _state: SessionState = "idle";
  private _client: Client;
  private _steeringQueue: string[] = [];
  private _followUpQueue: string[] = [];
  private _abortSignaled = false;
  private _eventListeners: Array<(event: SessionEvent) => void> = [];

  constructor(opts: {
    profile: ProviderProfile;
    env: ExecutionEnvironment;
    client: Client;
    config?: Partial<SessionConfig>;
  }) {
    this.id = crypto.randomUUID();
    this._profile = opts.profile;
    this._env = opts.env;
    this._client = opts.client;
    this._config = { ...DEFAULT_SESSION_CONFIG, ...opts.config };
  }

  get state(): SessionState { return this._state; }
  get history(): readonly Turn[] { return this._history; }

  onEvent(listener: (event: SessionEvent) => void): void {
    this._eventListeners.push(listener);
  }

  private emit(kind: SessionEventKind, data: Record<string, unknown> = {}): void {
    const event: SessionEvent = {
      kind,
      timestamp: new Date().toISOString(),
      session_id: this.id,
      data,
    };
    for (const listener of this._eventListeners) {
      listener(event);
    }
  }

  /**
   * Inject a steering message between tool rounds (Section 2.6).
   */
  steer(message: string): void {
    this._steeringQueue.push(message);
  }

  /**
   * Queue a follow-up message for after the current input completes.
   */
  followUp(message: string): void {
    this._followUpQueue.push(message);
  }

  /**
   * Signal abort — stops the loop.
   */
  abort(): void {
    this._abortSignaled = true;
  }

  /**
   * Submit user input and run the agentic loop (Section 2.5).
   */
  async submit(userInput: string): Promise<void> {
    this._state = "processing";
    this._history.push({ type: "user", content: userInput, timestamp: new Date().toISOString() });
    this.emit("user_input", { content: userInput });

    this.drainSteering();

    let roundCount = 0;

    while (true) {
      // Check limits
      if (roundCount >= this._config.max_tool_rounds_per_input) {
        this.emit("turn_limit", { round: roundCount });
        break;
      }

      if (this._config.max_turns > 0 && this.countTurns() >= this._config.max_turns) {
        this.emit("turn_limit", { total_turns: this.countTurns() });
        break;
      }

      if (this._abortSignaled) break;

      // Build LLM request
      const systemPrompt = this._profile.build_system_prompt(this._env);
      const messages = this.buildMessages();
      const toolDefs = this._profile.tools();

      const response = await this._client.complete({
        model: this._profile.model,
        messages: [Msg.system(systemPrompt), ...messages],
        tools: toolDefs,
        tool_choice: { mode: "auto" },
        reasoning_effort: this._config.reasoning_effort,
        provider: this._profile.id,
        provider_options: this._profile.provider_options?.() as Record<string, Record<string, unknown>> | undefined,
      });

      // Record assistant turn
      const toolCalls = responseToolCalls(response);
      const assistantTurn: Turn = {
        type: "assistant",
        content: messageText(response.message),
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: typeof tc.arguments === "string" ? JSON.parse(tc.arguments) : tc.arguments,
        })),
        reasoning: response.message.content
          .filter((p) => p.kind === "thinking" && p.thinking)
          .map((p) => p.thinking!.text)
          .join("") || undefined,
        usage: response.usage,
        response_id: response.id,
        timestamp: new Date().toISOString(),
      };
      this._history.push(assistantTurn);
      this.emit("assistant_text_end", { text: assistantTurn.content, reasoning: assistantTurn.reasoning });

      // If no tool calls, natural completion
      if (toolCalls.length === 0) break;

      // Execute tool calls
      roundCount++;
      const results = await this.executeToolCalls(assistantTurn.tool_calls);
      this._history.push({
        type: "tool_results",
        results,
        timestamp: new Date().toISOString(),
      });

      // Drain steering
      this.drainSteering();

      // Loop detection (Section 2.10)
      if (this._config.enable_loop_detection && this.detectLoop()) {
        const warning =
          `Loop detected: the last ${this._config.loop_detection_window} ` +
          `tool calls follow a repeating pattern. Try a different approach.`;
        this._history.push({ type: "steering", content: warning, timestamp: new Date().toISOString() });
        this.emit("loop_detection", { message: warning });
      }
    }

    // Process follow-ups
    if (this._followUpQueue.length > 0) {
      const nextInput = this._followUpQueue.shift()!;
      await this.submit(nextInput);
      return;
    }

    this._state = "idle";
    this.emit("session_end");
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private drainSteering(): void {
    while (this._steeringQueue.length > 0) {
      const msg = this._steeringQueue.shift()!;
      this._history.push({ type: "steering", content: msg, timestamp: new Date().toISOString() });
      this.emit("steering_injected", { content: msg });
    }
  }

  private countTurns(): number {
    return this._history.filter((t) => t.type === "user" || t.type === "assistant").length;
  }

  private buildMessages(): Message[] {
    const messages: Message[] = [];
    for (const turn of this._history) {
      switch (turn.type) {
        case "user":
          messages.push(Msg.user(turn.content));
          break;
        case "assistant": {
          const parts: Message["content"] = [];
          if (turn.content) {
            parts.push({ kind: "text", text: turn.content });
          }
          for (const tc of turn.tool_calls) {
            parts.push({
              kind: "tool_call",
              tool_call: { id: tc.id, name: tc.name, arguments: tc.arguments },
            });
          }
          messages.push({ role: "assistant", content: parts });
          break;
        }
        case "tool_results":
          for (const result of turn.results) {
            messages.push(Msg.toolResult(result.tool_call_id, result.content, result.is_error));
          }
          break;
        case "system":
          messages.push(Msg.system(turn.content));
          break;
        case "steering":
          messages.push(Msg.user(turn.content));
          break;
      }
    }
    return messages;
  }

  private async executeToolCalls(toolCalls: ToolCallEntry[]): Promise<ToolResultEntry[]> {
    const results: ToolResultEntry[] = [];

    for (const tc of toolCalls) {
      this.emit("tool_call_start", { tool_name: tc.name, call_id: tc.id });

      const registered = this._profile.tool_registry.get(tc.name);
      if (!registered) {
        const error = `Unknown tool: ${tc.name}`;
        this.emit("tool_call_end", { call_id: tc.id, error });
        results.push({ tool_call_id: tc.id, content: error, is_error: true });
        continue;
      }

      try {
        const rawOutput = await registered.executor(tc.arguments, this._env);
        const truncated = truncateToolOutput(rawOutput, tc.name, this._config);

        // Emit full output
        this.emit("tool_call_end", { call_id: tc.id, output: rawOutput });
        results.push({ tool_call_id: tc.id, content: truncated, is_error: false });
      } catch (err) {
        const error = `Tool error (${tc.name}): ${err}`;
        this.emit("tool_call_end", { call_id: tc.id, error });
        results.push({ tool_call_id: tc.id, content: error, is_error: true });
      }
    }

    return results;
  }

  /**
   * Loop detection (Section 2.10).
   * Check if the last N tool calls follow a repeating pattern.
   */
  private detectLoop(): boolean {
    const window = this._config.loop_detection_window;
    const signatures: string[] = [];

    for (const turn of this._history) {
      if (turn.type === "assistant") {
        for (const tc of turn.tool_calls) {
          signatures.push(`${tc.name}:${JSON.stringify(tc.arguments)}`);
        }
      }
    }

    if (signatures.length < window) return false;
    const recent = signatures.slice(-window);

    for (const patternLen of [1, 2, 3]) {
      if (window % patternLen !== 0) continue;
      const pattern = recent.slice(0, patternLen);
      let allMatch = true;
      for (let i = patternLen; i < window; i += patternLen) {
        const chunk = recent.slice(i, i + patternLen);
        if (chunk.length !== pattern.length || chunk.some((s, j) => s !== pattern[j])) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) return true;
    }

    return false;
  }
}
