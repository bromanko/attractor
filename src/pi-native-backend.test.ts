import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PiNativeBackend,
  detectSkippedToolResults,
  detectMutatingToolUse,
} from "./pi-native-backend.js";
import type { PiNativeBackendConfig } from "./pi-native-backend.js";
import type { GraphNode } from "./pipeline/types.js";
import { Context } from "./pipeline/types.js";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import type { Model, Api } from "@mariozechner/pi-ai";
import type { ThinkingLevel, AgentMessage } from "@mariozechner/pi-agent-core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: "test_node",
    attrs: {},
    ...overrides,
  };
}

function makeModel(id = "claude-test"): Model<Api> {
  return {
    id,
    name: "Test Model",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.test.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  };
}

// ---------------------------------------------------------------------------
// Mock pi extension API
// ---------------------------------------------------------------------------

interface MockPi {
  handlers: Map<string, ((...args: unknown[]) => unknown)[]>;
  activeTools: string[];
  thinkingLevel: ThinkingLevel;
  currentModel: Model<Api> | undefined;
  sendUserMessage: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  setActiveTools: ReturnType<typeof vi.fn>;
  setThinkingLevel: ReturnType<typeof vi.fn>;
  getActiveTools: ReturnType<typeof vi.fn>;
  getThinkingLevel: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

function createMockPi(): MockPi {
  const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();
  const mock: MockPi = {
    handlers,
    activeTools: ["bash", "read", "edit", "write", "grep", "find", "ls"],
    thinkingLevel: "medium" as ThinkingLevel,
    currentModel: makeModel(),
    sendUserMessage: vi.fn(),
    setModel: vi.fn(async () => true),
    setActiveTools: vi.fn((tools: string[]) => { mock.activeTools = tools; }),
    setThinkingLevel: vi.fn((level: ThinkingLevel) => { mock.thinkingLevel = level; }),
    getActiveTools: vi.fn(() => mock.activeTools),
    getThinkingLevel: vi.fn(() => mock.thinkingLevel),
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    }),
  };
  return mock;
}

interface MockCtx {
  model: Model<Api> | undefined;
  modelRegistry: { find: ReturnType<typeof vi.fn> };
  waitForIdle: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
}

function createMockCtx(model?: Model<Api>): MockCtx {
  return {
    model: model ?? makeModel(),
    modelRegistry: { find: vi.fn(() => makeModel()) },
    waitForIdle: vi.fn(async () => undefined),
    abort: vi.fn(),
  };
}

function createConfig(
  mockPi: MockPi,
  mockCtx: MockCtx,
  overrides: Partial<PiNativeBackendConfig> = {},
): PiNativeBackendConfig {
  return {
    pi: mockPi as unknown as ExtensionAPI,
    ctx: mockCtx as unknown as ExtensionCommandContext,
    model: "claude-test",
    provider: "anthropic",
    modelRegistry: mockCtx.modelRegistry as unknown as PiNativeBackendConfig["modelRegistry"],
    ...overrides,
  };
}

/** Helper to build an agent_end event payload. */
function agentEndEvent(responseText: string, extraMessages: unknown[] = []) {
  return {
    type: "agent_end",
    messages: [
      ...extraMessages,
      {
        role: "assistant",
        content: [{ type: "text", text: responseText }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    ],
  };
}

/**
 * Cast plain message objects to AgentMessage[].
 * Uses `unknown` intermediary instead of `any` so structural drift
 * is visible when the upstream type changes.
 */
function asMessages(msgs: Record<string, unknown>[]): AgentMessage[] {
  return msgs as unknown as AgentMessage[];
}

/** Make waitForIdle fire agent_end on the second call (after sendUserMessage). */
function mockWaitWithResponse(mockPi: MockPi, mockCtx: MockCtx, responseText: string, extraMessages: unknown[] = []): void {
  let calls = 0;
  mockCtx.waitForIdle.mockImplementation(async () => {
    calls++;
    if (calls < 2) return; // first call: just ensure idle
    const handlers = mockPi.handlers.get("agent_end") ?? [];
    for (const h of handlers) {
      h(agentEndEvent(responseText, extraMessages));
    }
  });
}

// ---------------------------------------------------------------------------
// Tests: detectSkippedToolResults
// ---------------------------------------------------------------------------

describe("detectSkippedToolResults", () => {
  it("returns false for normal messages", () => {
    const messages = asMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: "Here is the result." }],
      },
    ]);
    expect(detectSkippedToolResults(messages)).toBe(false);
  });

  it("detects skip text in assistant text content", () => {
    const messages = asMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: "Skipped due to queued user message." }],
      },
    ]);
    expect(detectSkippedToolResults(messages)).toBe(true);
  });

  it("detects skip text in tool_result content field", () => {
    const messages = asMessages([
      {
        role: "user",
        content: [
          { type: "tool_result", content: "Skipped due to queued user message.", tool_use_id: "123" },
        ],
      },
    ]);
    expect(detectSkippedToolResults(messages)).toBe(true);
  });

  it("detects skip text in tool_result text field", () => {
    const messages = asMessages([
      {
        role: "user",
        content: [
          { type: "tool_result", text: "Skipped due to queued user message.", tool_use_id: "123" },
        ],
      },
    ]);
    expect(detectSkippedToolResults(messages)).toBe(true);
  });

  it("returns false for empty messages array", () => {
    expect(detectSkippedToolResults([])).toBe(false);
  });

  it("is case-insensitive", () => {
    const messages = asMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: "skipped due to QUEUED USER MESSAGE" }],
      },
    ]);
    expect(detectSkippedToolResults(messages)).toBe(true);
  });

  it("returns false for messages without content array", () => {
    const messages = asMessages([
      { role: "system" },
      { role: "assistant" },
    ]);
    expect(detectSkippedToolResults(messages)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: detectMutatingToolUse
// ---------------------------------------------------------------------------

describe("detectMutatingToolUse", () => {
  it("returns false for read-only tools", () => {
    const messages = asMessages([
      {
        role: "assistant",
        content: [
          { type: "tool_use", name: "read", id: "1", input: {} },
          { type: "tool_use", name: "grep", id: "2", input: {} },
          { type: "tool_use", name: "find", id: "3", input: {} },
        ],
      },
    ]);
    expect(detectMutatingToolUse(messages)).toBe(false);
  });

  it("detects bash as mutating", () => {
    const messages = asMessages([
      {
        role: "assistant",
        content: [{ type: "tool_use", name: "bash", id: "1", input: {} }],
      },
    ]);
    expect(detectMutatingToolUse(messages)).toBe(true);
  });

  it("detects edit as mutating", () => {
    const messages = asMessages([
      {
        role: "assistant",
        content: [{ type: "tool_use", name: "edit", id: "1", input: {} }],
      },
    ]);
    expect(detectMutatingToolUse(messages)).toBe(true);
  });

  it("detects write as mutating", () => {
    const messages = asMessages([
      {
        role: "assistant",
        content: [{ type: "tool_use", name: "write", id: "1", input: {} }],
      },
    ]);
    expect(detectMutatingToolUse(messages)).toBe(true);
  });

  it("returns false for empty messages", () => {
    expect(detectMutatingToolUse([])).toBe(false);
  });

  it("returns false for messages without content array", () => {
    const messages = asMessages([
      { role: "system" },
      { role: "assistant" },
    ]);
    expect(detectMutatingToolUse(messages)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: PiNativeBackend
// ---------------------------------------------------------------------------

describe("PiNativeBackend", () => {
  let mockPi: MockPi;
  let mockCtx: MockCtx;

  beforeEach(() => {
    mockPi = createMockPi();
    mockCtx = createMockCtx();
  });

  it("sends prompt via pi.sendUserMessage and waits for idle", async () => {
    mockWaitWithResponse(mockPi, mockCtx, "I completed the task.");

    const backend = new PiNativeBackend(createConfig(mockPi, mockCtx));
    const node = makeNode();
    const context = new Context();
    const outcome = await backend.run(node, "Do the thing", context);

    expect(mockPi.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("Do the thing"),
      { deliverAs: "followUp" },
    );
    expect(mockCtx.waitForIdle).toHaveBeenCalled();
    expect(outcome.status).toBe("success");
    expect(outcome.context_updates?.["test_node._full_response"]).toContain("I completed the task.");
  });

  it("configures model for the stage and restores after", async () => {
    const stageModel = makeModel("stage-model");
    mockCtx.modelRegistry.find.mockReturnValue(stageModel);

    mockWaitWithResponse(mockPi, mockCtx, "done");

    const backend = new PiNativeBackend(createConfig(mockPi, mockCtx));
    const node = makeNode({ attrs: { llm_model: "stage-model" } });
    await backend.run(node, "test", new Context());

    // Should have set the stage model, then restored the original
    expect(mockPi.setModel).toHaveBeenCalledTimes(2);
    expect(mockPi.setModel.mock.calls[0][0]).toBe(stageModel);
    // Second call restores original
    expect(mockPi.setModel.mock.calls[1][0]).toBe(mockCtx.model);
  });

  it("configures tools based on toolMode", async () => {
    mockWaitWithResponse(mockPi, mockCtx, "");

    const backend = new PiNativeBackend(createConfig(mockPi, mockCtx, { toolMode: "read-only" }));
    await backend.run(makeNode(), "test", new Context());

    // Should set read-only tools, then restore original
    expect(mockPi.setActiveTools).toHaveBeenCalledWith(["read", "grep", "find", "ls"]);
  });

  it("returns cancelled outcome when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const backend = new PiNativeBackend(createConfig(mockPi, mockCtx));
    const outcome = await backend.run(makeNode(), "test", new Context(), { signal: controller.signal });

    expect(outcome.status).toBe("cancelled");
    expect(mockPi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("returns fail when model not found", async () => {
    mockCtx.modelRegistry.find.mockReturnValue(undefined);

    const backend = new PiNativeBackend(createConfig(mockPi, mockCtx));
    const outcome = await backend.run(makeNode(), "test", new Context());

    expect(outcome.status).toBe("fail");
    expect(outcome.failure_reason).toContain("Model not found");
  });

  it("returns fail when setModel fails (no API key)", async () => {
    mockPi.setModel.mockResolvedValue(false);

    const backend = new PiNativeBackend(createConfig(mockPi, mockCtx));
    const outcome = await backend.run(makeNode(), "test", new Context());

    expect(outcome.status).toBe("fail");
    expect(outcome.failure_reason).toContain("Failed to set model");
  });

  it("includes context summary in prompt", async () => {
    mockWaitWithResponse(mockPi, mockCtx, "");

    const context = new Context();
    context.set("graph.goal", "build something");

    const backend = new PiNativeBackend(createConfig(mockPi, mockCtx));
    await backend.run(makeNode(), "do it", context);

    const sentPrompt = mockPi.sendUserMessage.mock.calls[0][0] as string;
    expect(sentPrompt).toContain("graph.goal");
    expect(sentPrompt).toContain("build something");
    expect(sentPrompt).toContain("do it");
  });

  it("gates persistent handlers to the active run and avoids handler accumulation", async () => {
    const backend = new PiNativeBackend(createConfig(mockPi, mockCtx, {
      systemPrompt: "stage system prompt",
    }));

    let calls = 0;
    const activeRunOverrideResults: unknown[] = [];
    mockCtx.waitForIdle.mockImplementation(async () => {
      calls++;
      if (calls < 2) return;

      const beforeHandlers = mockPi.handlers.get("before_agent_start") ?? [];
      for (const h of beforeHandlers) {
        activeRunOverrideResults.push(h({
          type: "before_agent_start",
          prompt: "prompt",
          systemPrompt: "base",
        }));
      }

      const endHandlers = mockPi.handlers.get("agent_end") ?? [];
      for (const h of endHandlers) {
        h(agentEndEvent("first run"));
      }
    });

    await backend.run(makeNode(), "test", new Context());

    expect(activeRunOverrideResults).toContainEqual({ systemPrompt: "stage system prompt" });

    const beforeHandlersAfterRun = mockPi.handlers.get("before_agent_start") ?? [];
    const staleRunResults = beforeHandlersAfterRun.map((h) => h({
      type: "before_agent_start",
      prompt: "later prompt",
      systemPrompt: "later base",
    }));
    expect(staleRunResults.every((result) => result === undefined)).toBe(true);

    mockWaitWithResponse(mockPi, mockCtx, "second run");
    await backend.run(makeNode(), "test", new Context());

    expect(mockPi.handlers.get("before_agent_start")).toHaveLength(1);
    expect(mockPi.handlers.get("agent_end")).toHaveLength(1);
  });

  it("maps thrown setModel rejection to fail and still restores state", async () => {
    mockPi.setModel
      .mockRejectedValueOnce(new Error("setModel exploded"))
      .mockResolvedValue(true);

    const backend = new PiNativeBackend(createConfig(mockPi, mockCtx));
    const outcome = await backend.run(makeNode(), "test", new Context());

    expect(outcome.status).toBe("fail");
    expect(outcome.failure_reason).toBe("LLM error: setModel exploded");
    // restore path still runs
    expect(mockPi.setModel).toHaveBeenCalledTimes(2);
    expect(mockPi.setModel.mock.calls[1][0]).toBe(mockCtx.model);
    expect(mockPi.setActiveTools).toHaveBeenCalledTimes(1); // restore only
    expect(mockPi.setThinkingLevel).toHaveBeenCalledTimes(1); // restore only
  });

  it("maps waitForIdle rejection to fail and still restores state", async () => {
    mockCtx.waitForIdle.mockRejectedValue(new Error("waitForIdle exploded"));

    const backend = new PiNativeBackend(createConfig(mockPi, mockCtx));
    const outcome = await backend.run(makeNode(), "test", new Context());

    expect(outcome.status).toBe("fail");
    expect(outcome.failure_reason).toBe("LLM error: waitForIdle exploded");
    expect(mockPi.setActiveTools).toHaveBeenCalledTimes(2); // set + restore
    expect(mockPi.setThinkingLevel).toHaveBeenCalledTimes(1); // restore only
  });

  it("maps sendUserMessage rejection to fail and still restores state", async () => {
    mockPi.sendUserMessage.mockRejectedValue(new Error("sendUserMessage exploded"));

    const backend = new PiNativeBackend(createConfig(mockPi, mockCtx));
    const outcome = await backend.run(makeNode(), "test", new Context());

    expect(outcome.status).toBe("fail");
    expect(outcome.failure_reason).toBe("LLM error: sendUserMessage exploded");
    expect(mockPi.setActiveTools).toHaveBeenCalledTimes(2); // set + restore
    expect(mockPi.setThinkingLevel).toHaveBeenCalledTimes(1); // restore only
  });

  it("restores state even on error", async () => {
    let calls = 0;
    mockCtx.waitForIdle.mockImplementation(async () => {
      calls++;
      if (calls >= 2) throw new Error("connection lost");
    });

    const backend = new PiNativeBackend(createConfig(mockPi, mockCtx));
    const outcome = await backend.run(makeNode(), "test", new Context());

    expect(outcome.status).toBe("fail");
    expect(outcome.failure_reason).toContain("connection lost");
    // State should still be restored
    expect(mockPi.setActiveTools).toHaveBeenCalledTimes(2); // set + restore
    expect(mockPi.setThinkingLevel).toHaveBeenCalledTimes(1); // restore only (no per-stage override)
  });

  // ---------------------------------------------------------------------------
  // Completion latch tests (Section A.1–A.2)
  // ---------------------------------------------------------------------------

  describe("completion latch", () => {
    it("does not parse outcome until agent_end is captured", async () => {
      // agent_end fires during the second waitForIdle — standard path
      mockWaitWithResponse(mockPi, mockCtx, "Result with [STATUS: success]");

      const backend = new PiNativeBackend(createConfig(mockPi, mockCtx));
      const node = makeNode({ attrs: { auto_status: true } });
      const outcome = await backend.run(node, "review", new Context());

      expect(outcome.status).toBe("success");
      expect(outcome.context_updates?.["test_node._full_response"]).toContain("[STATUS: success]");
    });

    it("waits for agent_end with bounded timeout when not captured during waitForIdle", async () => {
      // agent_end fires AFTER waitForIdle completes (with small delay)
      let calls = 0;
      mockCtx.waitForIdle.mockImplementation(async () => {
        calls++;
        // Don't fire agent_end during either waitForIdle call
      });

      // Fire agent_end after a short delay (simulating late arrival)
      const backend = new PiNativeBackend(createConfig(mockPi, mockCtx, {
        agentEndTimeoutMs: 500,
      }));

      // Start the run, then fire agent_end after 50ms
      const runPromise = backend.run(makeNode(), "test", new Context());

      setTimeout(() => {
        const handlers = mockPi.handlers.get("agent_end") ?? [];
        for (const h of handlers) {
          h(agentEndEvent("Late response arrived"));
        }
      }, 50);

      const outcome = await runPromise;
      expect(outcome.status).toBe("success");
      expect(outcome.context_updates?.["test_node._full_response"]).toContain("Late response arrived");
    });

    it("returns cancelled when abort fires during completion latch wait", async () => {
      // agent_end never fires during waitForIdle — enters latch
      mockCtx.waitForIdle.mockImplementation(async () => {
        // never fire agent_end
      });

      const controller = new AbortController();
      const backend = new PiNativeBackend(createConfig(mockPi, mockCtx, {
        agentEndTimeoutMs: 5000, // long timeout so abort wins the race
      }));

      const node = makeNode();
      const runPromise = backend.run(node, "test", new Context(), { signal: controller.signal });

      // Abort after 50ms — while the latch is waiting
      setTimeout(() => controller.abort(), 50);

      const outcome = await runPromise;
      expect(outcome.status).toBe("cancelled");
      expect(outcome.failure_reason).toContain("Cancelled");
      expect(mockCtx.abort).toHaveBeenCalled();
    });

    it("returns empty response on timeout when agent_end never arrives", async () => {
      // agent_end never fires — should timeout
      mockCtx.waitForIdle.mockImplementation(async () => {
        // never fire agent_end
      });

      const backend = new PiNativeBackend(createConfig(mockPi, mockCtx, {
        agentEndTimeoutMs: 50, // short timeout for test
      }));

      const node = makeNode({ attrs: { auto_status: true } });
      const outcome = await backend.run(node, "test", new Context());

      // auto_status=true with empty response → fail with empty_response class
      expect(outcome.status).toBe("fail");
      expect(outcome.failure_class).toBe("empty_response");
    });
  });

  // ---------------------------------------------------------------------------
  // Skip detection + retry tests (Section A.3–A.5)
  // ---------------------------------------------------------------------------

  describe("skip detection and protocol retry", () => {
    it("retries once when tool results are skipped and no mutating tools ran", async () => {
      let dispatchCount = 0;
      mockCtx.waitForIdle.mockImplementation(async () => {
        dispatchCount++;
        // Every second waitForIdle call fires agent_end
        if (dispatchCount % 2 === 0) {
          const handlers = mockPi.handlers.get("agent_end") ?? [];
          const isRetry = dispatchCount > 2;
          for (const h of handlers) {
            if (isRetry) {
              // Second attempt: clean response
              h(agentEndEvent("Clean response. [STATUS: success]"));
            } else {
              // First attempt: has skip indicator
              h({
                type: "agent_end",
                messages: [
                  {
                    role: "user",
                    content: [
                      { type: "tool_result", text: "Skipped due to queued user message.", tool_use_id: "1" },
                    ],
                  },
                  {
                    role: "assistant",
                    content: [
                      { type: "tool_use", name: "read", id: "1", input: {} },
                      { type: "text", text: "partial" },
                    ],
                  },
                ],
              });
            }
          }
        }
      });

      const backend = new PiNativeBackend(createConfig(mockPi, mockCtx));
      const context = new Context();
      const node = makeNode({ attrs: { auto_status: true } });
      const outcome = await backend.run(node, "review", context);

      // Should have retried and succeeded
      expect(outcome.status).toBe("success");
      expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(2);
      expect(context.logs.some(l => l.includes("skipped tool results"))).toBe(true);
    });

    it("fails with tool_result_skipped when skip occurs after mutating tools", async () => {
      let calls = 0;
      mockCtx.waitForIdle.mockImplementation(async () => {
        calls++;
        if (calls === 2) {
          const handlers = mockPi.handlers.get("agent_end") ?? [];
          for (const h of handlers) {
            h({
              type: "agent_end",
              messages: [
                {
                  role: "assistant",
                  content: [
                    { type: "tool_use", name: "bash", id: "1", input: { command: "echo hello" } },
                    { type: "text", text: "Running..." },
                  ],
                },
                {
                  role: "user",
                  content: [
                    { type: "tool_result", text: "Skipped due to queued user message.", tool_use_id: "2" },
                  ],
                },
              ],
            });
          }
        }
      });

      const backend = new PiNativeBackend(createConfig(mockPi, mockCtx));
      const outcome = await backend.run(makeNode(), "implement", new Context());

      // Should NOT retry — mutating tool ran
      expect(outcome.status).toBe("fail");
      expect(outcome.failure_class).toBe("tool_result_skipped");
      expect(outcome.failure_reason).toContain("mutating tool side effects");
      expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);
    });

    it("fails after exhausting retry budget for repeated skips", async () => {
      // All attempts have skip indicators with read-only tools
      mockCtx.waitForIdle.mockImplementation(async function () {
        // Fire agent_end with skip on every second call
        const allCalls = mockCtx.waitForIdle.mock.calls.length;
        if (allCalls % 2 === 0) {
          const handlers = mockPi.handlers.get("agent_end") ?? [];
          for (const h of handlers) {
            h({
              type: "agent_end",
              messages: [
                {
                  role: "assistant",
                  content: [
                    { type: "tool_use", name: "read", id: "1", input: {} },
                  ],
                },
                {
                  role: "user",
                  content: [
                    { type: "tool_result", text: "Skipped due to queued user message.", tool_use_id: "1" },
                  ],
                },
              ],
            });
          }
        }
      });

      const backend = new PiNativeBackend(createConfig(mockPi, mockCtx));
      const outcome = await backend.run(makeNode(), "test", new Context());

      expect(outcome.status).toBe("fail");
      expect(outcome.failure_class).toBe("tool_result_skipped");
      expect(outcome.failure_reason).toContain("retry was exhausted");
      expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(2); // original + 1 retry
    });
  });

  // ---------------------------------------------------------------------------
  // Status marker race test (Section A.6)
  // ---------------------------------------------------------------------------

  describe("status marker reliability", () => {
    it("returns success when assistant message has status marker (no false negative)", async () => {
      mockWaitWithResponse(mockPi, mockCtx, "Review complete. No issues found.\n[STATUS: success]");

      const backend = new PiNativeBackend(createConfig(mockPi, mockCtx));
      const node = makeNode({ attrs: { auto_status: true } });
      const outcome = await backend.run(node, "review code", new Context());

      expect(outcome.status).toBe("success");
      expect(outcome.failure_class).toBeUndefined();
    });

    it("retries once on empty_response protocol failure", async () => {
      let dispatchCount = 0;
      mockCtx.waitForIdle.mockImplementation(async () => {
        dispatchCount++;
        if (dispatchCount % 2 === 0) {
          const handlers = mockPi.handlers.get("agent_end") ?? [];
          const isRetry = dispatchCount > 2;
          for (const h of handlers) {
            if (isRetry) {
              h(agentEndEvent("Retry response.\n[STATUS: success]"));
            } else {
              // First attempt: empty response (agent_end with no real text)
              h(agentEndEvent(""));
            }
          }
        }
      });

      const backend = new PiNativeBackend(createConfig(mockPi, mockCtx));
      const node = makeNode({ attrs: { auto_status: true } });
      const context = new Context();
      const outcome = await backend.run(node, "review", context);

      // Should have retried and succeeded on second attempt
      expect(outcome.status).toBe("success");
      expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(2);
      expect(context.logs.some(l => l.includes("empty_response"))).toBe(true);
    });

    it("retries once on missing_status_marker when response has text but no marker", async () => {
      let dispatchCount = 0;
      mockCtx.waitForIdle.mockImplementation(async () => {
        dispatchCount++;
        if (dispatchCount % 2 === 0) {
          const handlers = mockPi.handlers.get("agent_end") ?? [];
          const isRetry = dispatchCount > 2;
          for (const h of handlers) {
            if (isRetry) {
              // Second attempt: proper marker
              h(agentEndEvent("All good.\n[STATUS: success]"));
            } else {
              // First attempt: non-empty text but no status marker
              h(agentEndEvent("Review complete, no issues found."));
            }
          }
        }
      });

      const backend = new PiNativeBackend(createConfig(mockPi, mockCtx));
      const node = makeNode({ attrs: { auto_status: true } });
      const context = new Context();
      const outcome = await backend.run(node, "review", context);

      expect(outcome.status).toBe("success");
      expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(2);
      expect(context.logs.some(l => l.includes("missing_status_marker"))).toBe(true);
    });

    it("does not retry semantic [STATUS: fail] failures", async () => {
      mockWaitWithResponse(mockPi, mockCtx, "Code quality issues found.\n[STATUS: fail]\n[FAILURE_REASON: Missing error handling]");

      const backend = new PiNativeBackend(createConfig(mockPi, mockCtx));
      const node = makeNode({ attrs: { auto_status: true } });
      const outcome = await backend.run(node, "review", new Context());

      // Should NOT retry — this is a semantic failure
      expect(outcome.status).toBe("fail");
      expect(outcome.failure_reason).toBe("Missing error handling");
      expect(outcome.failure_class).toBeUndefined();
      expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);
    });
  });
});
