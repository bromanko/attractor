/**
 * Tests for LlmBackend — the bridge between pipeline engine and LLM client.
 */

import { describe, it, expect, vi } from "vitest";
import { LlmBackend } from "./llm-backend.js";
import { Context } from "./types.js";
import type { GraphNode } from "./types.js";
import { Client } from "../llm/client.js";
import type { ProviderAdapter, Request, Response, StreamEvent } from "../llm/types.js";

// ---------------------------------------------------------------------------
// Mock provider adapter
// ---------------------------------------------------------------------------

function mockAdapter(responseText: string, overrides: Partial<Response> = {}): ProviderAdapter {
  return {
    name: "mock",
    async complete(request: Request): Promise<Response> {
      return {
        id: "resp_01",
        model: request.model,
        provider: "mock",
        message: {
          role: "assistant",
          content: [{ kind: "text", text: responseText }],
        },
        finish_reason: { reason: "stop" },
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        ...overrides,
      };
    },
    async *stream(): AsyncIterable<StreamEvent> {},
  };
}

function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: "implement",
    attrs: { label: "Implement", prompt: "Write the code" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LlmBackend", () => {
  it("returns success outcome for normal LLM response", async () => {
    const client = new Client({
      providers: { mock: mockAdapter("Here is the implementation.") },
    });

    const backend = new LlmBackend({ client, model: "test-model" });
    const context = new Context();
    const node = makeNode();

    const outcome = await backend.run(node, "Write the code", context);

    expect(outcome.status).toBe("success");
    expect(outcome.notes).toContain("Here is the implementation.");
    expect(outcome.context_updates!["implement.response"]).toContain("Here is the implementation.");
    expect(outcome.context_updates!["implement.usage.input_tokens"]).toBe(10);
    expect(outcome.context_updates!["implement.usage.output_tokens"]).toBe(20);
  });

  it("parses [STATUS: fail] marker in response", async () => {
    const client = new Client({
      providers: {
        mock: mockAdapter("I couldn't complete this.\n[STATUS: fail]\n[FAILURE_REASON: Missing dependency]"),
      },
    });

    const backend = new LlmBackend({ client, model: "test-model" });
    const outcome = await backend.run(makeNode(), "Do something", new Context());

    expect(outcome.status).toBe("fail");
    expect(outcome.failure_reason).toBe("Missing dependency");
  });

  it("parses [PREFERRED_LABEL: ...] for routing", async () => {
    const client = new Client({
      providers: {
        mock: mockAdapter("Tests passed!\n[STATUS: success]\n[PREFERRED_LABEL: Yes]"),
      },
    });

    const backend = new LlmBackend({ client, model: "test-model" });
    const outcome = await backend.run(makeNode(), "Run tests", new Context());

    expect(outcome.status).toBe("success");
    expect(outcome.preferred_label).toBe("Yes");
  });

  it("parses [NEXT: node_id] for suggested routing", async () => {
    const client = new Client({
      providers: {
        mock: mockAdapter("Done. [NEXT: deploy] [NEXT: notify]"),
      },
    });

    const backend = new LlmBackend({ client, model: "test-model" });
    const outcome = await backend.run(makeNode(), "Complete", new Context());

    expect(outcome.suggested_next_ids).toEqual(["deploy", "notify"]);
  });

  it("uses per-node llm_model override", async () => {
    const completeSpy = vi.fn().mockResolvedValue({
      id: "resp_01",
      model: "claude-opus-4-6",
      provider: "mock",
      message: { role: "assistant", content: [{ kind: "text", text: "ok" }] },
      finish_reason: { reason: "stop" },
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });

    const client = new Client({
      providers: {
        mock: { name: "mock", complete: completeSpy, async *stream() {} },
      },
    });

    const backend = new LlmBackend({ client, model: "default-model" });
    const node = makeNode({
      attrs: { label: "Special", llm_model: "claude-opus-4-6" },
    });

    await backend.run(node, "Do it", new Context());

    expect(completeSpy).toHaveBeenCalledTimes(1);
    const request = completeSpy.mock.calls[0][0];
    expect(request.model).toBe("claude-opus-4-6");
  });

  it("includes pipeline context in prompt", async () => {
    const completeSpy = vi.fn().mockResolvedValue({
      id: "resp_01",
      model: "test",
      provider: "mock",
      message: { role: "assistant", content: [{ kind: "text", text: "ok" }] },
      finish_reason: { reason: "stop" },
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });

    const client = new Client({
      providers: {
        mock: { name: "mock", complete: completeSpy, async *stream() {} },
      },
    });

    const backend = new LlmBackend({ client, model: "test" });
    const context = new Context();
    context.set("plan.steps", "1. Create file\n2. Write tests");

    await backend.run(makeNode(), "Implement the plan", context);

    const request = completeSpy.mock.calls[0][0];
    const userMsg = request.messages.find((m: any) => m.role === "user");
    expect(userMsg.content[0].text).toContain("plan.steps");
    expect(userMsg.content[0].text).toContain("Implement the plan");
  });

  it("uses custom parseOutcome", async () => {
    const client = new Client({
      providers: { mock: mockAdapter("LGTM 👍") },
    });

    const backend = new LlmBackend({
      client,
      model: "test",
      parseOutcome: (text, node) => ({
        status: text.includes("LGTM") ? "success" : "fail",
        notes: `Custom: ${node.id}`,
      }),
    });

    const outcome = await backend.run(makeNode(), "Review", new Context());

    expect(outcome.status).toBe("success");
    expect(outcome.notes).toBe("Custom: implement");
  });

  it("passes system prompt when configured", async () => {
    const completeSpy = vi.fn().mockResolvedValue({
      id: "resp_01",
      model: "test",
      provider: "mock",
      message: { role: "assistant", content: [{ kind: "text", text: "ok" }] },
      finish_reason: { reason: "stop" },
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });

    const client = new Client({
      providers: {
        mock: { name: "mock", complete: completeSpy, async *stream() {} },
      },
    });

    const backend = new LlmBackend({
      client,
      model: "test",
      systemPrompt: "You are a senior engineer.",
    });

    await backend.run(makeNode(), "Code it", new Context());

    const request = completeSpy.mock.calls[0][0];
    const sysMsg = request.messages.find((m: any) => m.role === "system");
    expect(sysMsg.content[0].text).toBe("You are a senior engineer.");
  });
});
