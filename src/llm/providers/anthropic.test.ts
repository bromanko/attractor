/**
 * Tests for the Anthropic provider adapter.
 *
 * These test the conversion/mapping logic without hitting the real API.
 * We mock fetch to return canned Anthropic API responses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AnthropicAdapter } from "./anthropic.js";
import type { Request, Response } from "../types.js";
import { Msg } from "../types.js";
import {
  AuthenticationError,
  RateLimitError,
  ServerError,
  ConfigurationError,
  InvalidRequestError,
} from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function anthropicResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_01abc",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Hello!" }],
    model: "claude-sonnet-4-5",
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  };
}

function mockFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

function makeAdapter() {
  return new AnthropicAdapter({ apiKey: "test-key" });
}

function simpleRequest(overrides: Partial<Request> = {}): Request {
  return {
    model: "claude-sonnet-4-5",
    messages: [Msg.user("Hi")],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AnthropicAdapter", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("throws ConfigurationError when no API key", () => {
      const orig = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      try {
        expect(() => new AnthropicAdapter()).toThrow(ConfigurationError);
      } finally {
        if (orig) process.env.ANTHROPIC_API_KEY = orig;
      }
    });

    it("uses apiKey from config", () => {
      const adapter = new AnthropicAdapter({ apiKey: "sk-test" });
      expect(adapter.name).toBe("anthropic");
    });
  });

  describe("complete", () => {
    it("sends correct headers and returns mapped response", async () => {
      const fetchMock = mockFetch(anthropicResponse());
      globalThis.fetch = fetchMock;
      const adapter = makeAdapter();

      const result = await adapter.complete(simpleRequest());

      // Check fetch was called correctly
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      expect(opts.headers["x-api-key"]).toBe("test-key");
      expect(opts.headers["anthropic-version"]).toBe("2023-06-01");

      // Check body
      const body = JSON.parse(opts.body);
      expect(body.model).toBe("claude-sonnet-4-5");
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].role).toBe("user");

      // Check response mapping
      expect(result.id).toBe("msg_01abc");
      expect(result.provider).toBe("anthropic");
      expect(result.finish_reason.reason).toBe("stop");
      expect(result.usage.input_tokens).toBe(10);
      expect(result.usage.output_tokens).toBe(5);
      expect(result.usage.total_tokens).toBe(15);
      expect(result.message.role).toBe("assistant");
      expect(result.message.content[0].kind).toBe("text");
      expect(result.message.content[0].text).toBe("Hello!");
    });

    it("extracts system messages into top-level system param", async () => {
      const fetchMock = mockFetch(anthropicResponse());
      globalThis.fetch = fetchMock;
      const adapter = makeAdapter();

      await adapter.complete(
        simpleRequest({
          messages: [Msg.system("Be helpful"), Msg.user("Hi")],
        }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.system).toBe("Be helpful");
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].role).toBe("user");
    });

    it("maps tool_use response to tool_call content parts", async () => {
      const fetchMock = mockFetch(
        anthropicResponse({
          content: [
            { type: "text", text: "Let me read that file." },
            {
              type: "tool_use",
              id: "toolu_01abc",
              name: "read_file",
              input: { file_path: "/tmp/test.txt" },
            },
          ],
          stop_reason: "tool_use",
        }),
      );
      globalThis.fetch = fetchMock;
      const adapter = makeAdapter();

      const result = await adapter.complete(simpleRequest());

      expect(result.finish_reason.reason).toBe("tool_calls");
      expect(result.message.content).toHaveLength(2);
      expect(result.message.content[0].kind).toBe("text");
      expect(result.message.content[1].kind).toBe("tool_call");
      expect(result.message.content[1].tool_call!.id).toBe("toolu_01abc");
      expect(result.message.content[1].tool_call!.name).toBe("read_file");
      expect(result.message.content[1].tool_call!.arguments).toEqual({
        file_path: "/tmp/test.txt",
      });
    });

    it("converts tools to Anthropic format", async () => {
      const fetchMock = mockFetch(anthropicResponse());
      globalThis.fetch = fetchMock;
      const adapter = makeAdapter();

      await adapter.complete(
        simpleRequest({
          tools: [
            {
              name: "read_file",
              description: "Read a file",
              parameters: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
              },
            },
          ],
          tool_choice: { mode: "auto" },
        }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0].name).toBe("read_file");
      expect(body.tools[0].input_schema).toBeDefined();
      expect(body.tool_choice).toEqual({ type: "auto" });
    });

    it("maps tool_choice modes correctly", async () => {
      const fetchMock = mockFetch(anthropicResponse());
      globalThis.fetch = fetchMock;
      const adapter = makeAdapter();

      const dummyTools = [
        { name: "read_file", description: "Read", parameters: { type: "object" } },
      ];

      // required → any
      await adapter.complete(
        simpleRequest({ tools: dummyTools, tool_choice: { mode: "required" } }),
      );
      let body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.tool_choice).toEqual({ type: "any" });

      // named → tool
      await adapter.complete(
        simpleRequest({
          tools: dummyTools,
          tool_choice: { mode: "named", tool_name: "read_file" },
        }),
      );
      body = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(body.tool_choice).toEqual({ type: "tool", name: "read_file" });

      // none
      await adapter.complete(
        simpleRequest({ tools: dummyTools, tool_choice: { mode: "none" } }),
      );
      body = JSON.parse(fetchMock.mock.calls[2][1].body);
      expect(body.tool_choice).toEqual({ type: "none" });
    });

    it("handles tool result messages", async () => {
      const fetchMock = mockFetch(anthropicResponse());
      globalThis.fetch = fetchMock;
      const adapter = makeAdapter();

      await adapter.complete(
        simpleRequest({
          messages: [
            Msg.user("Read this file"),
            {
              role: "assistant",
              content: [
                {
                  kind: "tool_call",
                  tool_call: {
                    id: "toolu_01",
                    name: "read_file",
                    arguments: { file_path: "/tmp/test" },
                  },
                },
              ],
            },
            Msg.toolResult("toolu_01", "file contents here"),
          ],
        }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // tool_result should be in a user message
      expect(body.messages).toHaveLength(3);
      expect(body.messages[2].role).toBe("user");
      const content = body.messages[2].content;
      expect(content[0].type).toBe("tool_result");
      expect(content[0].tool_use_id).toBe("toolu_01");
      expect(content[0].content).toBe("file contents here");
    });

    it("maps thinking blocks in response", async () => {
      const fetchMock = mockFetch(
        anthropicResponse({
          content: [
            {
              type: "thinking",
              thinking: "Let me think about this...",
              signature: "sig123",
            },
            { type: "text", text: "Here's my answer." },
          ],
        }),
      );
      globalThis.fetch = fetchMock;
      const adapter = makeAdapter();

      const result = await adapter.complete(simpleRequest());

      expect(result.message.content).toHaveLength(2);
      expect(result.message.content[0].kind).toBe("thinking");
      expect(result.message.content[0].thinking!.text).toBe(
        "Let me think about this...",
      );
      expect(result.message.content[0].thinking!.redacted).toBe(false);
      expect(result.message.content[1].kind).toBe("text");
    });

    it("enables thinking when reasoning_effort is set", async () => {
      const fetchMock = mockFetch(anthropicResponse());
      globalThis.fetch = fetchMock;
      const adapter = makeAdapter();

      await adapter.complete(
        simpleRequest({ reasoning_effort: "high" }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.thinking).toEqual({
        type: "enabled",
        budget_tokens: 32768,
      });
    });

    it("maps cache usage tokens", async () => {
      const fetchMock = mockFetch(
        anthropicResponse({
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 30,
          },
        }),
      );
      globalThis.fetch = fetchMock;
      const adapter = makeAdapter();

      const result = await adapter.complete(simpleRequest());

      expect(result.usage.cache_write_tokens).toBe(20);
      expect(result.usage.cache_read_tokens).toBe(30);
    });

    it("uses custom base URL", async () => {
      const fetchMock = mockFetch(anthropicResponse());
      globalThis.fetch = fetchMock;
      const adapter = new AnthropicAdapter({
        apiKey: "test-key",
        baseUrl: "https://custom.proxy.example",
      });

      await adapter.complete(simpleRequest());

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe("https://custom.proxy.example/v1/messages");
    });

    it("forwards provider_options.anthropic", async () => {
      const fetchMock = mockFetch(anthropicResponse());
      globalThis.fetch = fetchMock;
      const adapter = makeAdapter();

      await adapter.complete(
        simpleRequest({
          provider_options: {
            anthropic: { metadata: { user_id: "u123" } },
          },
        }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.metadata).toEqual({ user_id: "u123" });
    });

    it("merges consecutive user messages", async () => {
      const fetchMock = mockFetch(anthropicResponse());
      globalThis.fetch = fetchMock;
      const adapter = makeAdapter();

      await adapter.complete(
        simpleRequest({
          messages: [Msg.user("First"), Msg.user("Second")],
        }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // Should be merged into one user message with two text blocks
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].role).toBe("user");
      expect(body.messages[0].content).toHaveLength(2);
    });
  });

  describe("error handling", () => {
    it("throws AuthenticationError on 401", async () => {
      globalThis.fetch = mockFetch(
        { type: "error", error: { type: "authentication_error", message: "Invalid API key" } },
        401,
      );
      const adapter = makeAdapter();

      await expect(adapter.complete(simpleRequest())).rejects.toThrow(
        AuthenticationError,
      );
    });

    it("throws RateLimitError on 429", async () => {
      globalThis.fetch = mockFetch(
        { type: "error", error: { type: "rate_limit_error", message: "Too many requests" } },
        429,
      );
      const adapter = makeAdapter();

      await expect(adapter.complete(simpleRequest())).rejects.toThrow(
        RateLimitError,
      );
    });

    it("throws ServerError on 500", async () => {
      globalThis.fetch = mockFetch(
        { type: "error", error: { type: "api_error", message: "Internal error" } },
        500,
      );
      const adapter = makeAdapter();

      await expect(adapter.complete(simpleRequest())).rejects.toThrow(
        ServerError,
      );
    });

    it("throws InvalidRequestError on 400", async () => {
      globalThis.fetch = mockFetch(
        { type: "error", error: { type: "invalid_request_error", message: "Bad request" } },
        400,
      );
      const adapter = makeAdapter();

      await expect(adapter.complete(simpleRequest())).rejects.toThrow(
        InvalidRequestError,
      );
    });
  });
});
