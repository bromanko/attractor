/**
 * Tests for LlmBackend — the bridge between pipeline engine and LLM client.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

  // -----------------------------------------------------------------------
  // prompt_file tests
  // -----------------------------------------------------------------------

  it("loads a single prompt_file and prepends to prompt", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "pf-test-"));
    try {
      await writeFile(join(tmpDir, "review.md"), "# Review Checklist\n- Check types\n- Check tests");

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
      const node = makeNode({
        attrs: {
          label: "Review",
          prompt_file: join(tmpDir, "review.md"),
        },
      });

      await backend.run(node, "Review the code", new Context());

      const request = completeSpy.mock.calls[0][0];
      const userMsg = request.messages.find((m: any) => m.role === "user");
      const text = userMsg.content[0].text;

      // File content should appear before the inline prompt
      expect(text).toContain("# Review Checklist");
      expect(text).toContain("Check types");
      expect(text).toContain("Review the code");
      expect(text.indexOf("Review Checklist")).toBeLessThan(text.indexOf("Review the code"));
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("loads multiple comma-separated prompt_files in order", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "pf-test-"));
    try {
      await writeFile(join(tmpDir, "code.md"), "CODE REVIEW INSTRUCTIONS");
      await writeFile(join(tmpDir, "security.md"), "SECURITY REVIEW INSTRUCTIONS");

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
      const node = makeNode({
        attrs: {
          label: "Review",
          prompt_file: `${join(tmpDir, "code.md")}, ${join(tmpDir, "security.md")}`,
        },
      });

      await backend.run(node, "Review changes", new Context());

      const request = completeSpy.mock.calls[0][0];
      const text = request.messages.find((m: any) => m.role === "user").content[0].text;

      // Both files present, in order, before inline prompt
      expect(text).toContain("CODE REVIEW INSTRUCTIONS");
      expect(text).toContain("SECURITY REVIEW INSTRUCTIONS");
      expect(text).toContain("Review changes");
      expect(text.indexOf("CODE REVIEW")).toBeLessThan(text.indexOf("SECURITY REVIEW"));
      expect(text.indexOf("SECURITY REVIEW")).toBeLessThan(text.indexOf("Review changes"));
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws when prompt_file does not exist", async () => {
    const client = new Client({
      providers: { mock: mockAdapter("ok") },
    });

    const backend = new LlmBackend({ client, model: "test" });
    const node = makeNode({
      attrs: { label: "Review", prompt_file: "/nonexistent/file.md" },
    });

    await expect(backend.run(node, "Review", new Context())).rejects.toThrow(
      /Failed to read prompt_file/,
    );
  });

  it("works normally when no prompt_file attribute is set", async () => {
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
    await backend.run(makeNode(), "Just a prompt", new Context());

    const request = completeSpy.mock.calls[0][0];
    const text = request.messages.find((m: any) => m.role === "user").content[0].text;
    expect(text).toContain("Just a prompt");
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
