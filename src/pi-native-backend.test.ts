import { describe, it, expect, vi, beforeEach } from "vitest";
import { PiNativeBackend } from "./pi-native-backend.js";
import type { PiNativeBackendConfig } from "./pi-native-backend.js";
import type { GraphNode } from "./pipeline/types.js";
import { Context } from "./pipeline/types.js";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import type { Model, Api } from "@mariozechner/pi-ai";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

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

/** Make waitForIdle fire agent_end on the second call (after sendUserMessage). */
function mockWaitWithResponse(mockPi: MockPi, mockCtx: MockCtx, responseText: string): void {
  let calls = 0;
  mockCtx.waitForIdle.mockImplementation(async () => {
    calls++;
    if (calls < 2) return; // first call: just ensure idle
    const handlers = mockPi.handlers.get("agent_end") ?? [];
    for (const h of handlers) {
      h({
        type: "agent_end",
        messages: [{
          role: "assistant",
          content: [{ type: "text", text: responseText }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-test",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: Date.now(),
        }],
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Tests
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
        h({
          type: "agent_end",
          messages: [{
            role: "assistant",
            content: [{ type: "text", text: "first run" }],
            api: "anthropic-messages",
            provider: "anthropic",
            model: "claude-test",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop",
            timestamp: Date.now(),
          }],
        });
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
});
