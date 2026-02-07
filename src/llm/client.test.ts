import { describe, it, expect } from "vitest";
import { Client, generate } from "./client.js";
import type { ProviderAdapter, Request, Response, StreamEvent, ToolDefinition } from "./types.js";
import { Msg, ConfigurationError } from "./types.js";

/** Minimal test adapter */
function mockAdapter(name: string, response?: Partial<Response>): ProviderAdapter {
  return {
    name,
    async complete(req: Request): Promise<Response> {
      return {
        id: "test-id",
        model: req.model,
        provider: name,
        message: { role: "assistant", content: [{ kind: "text", text: response?.message ? "" : "Hello from " + name }] },
        finish_reason: { reason: "stop" },
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        ...response,
      } as Response;
    },
    async *stream(_req: Request): AsyncIterable<StreamEvent> {
      yield { type: "text_delta", delta: "Hello" };
      yield { type: "finish", finish_reason: { reason: "stop" }, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
    },
  };
}

describe("Client", () => {
  it("routes to the correct provider", async () => {
    const client = new Client({
      providers: { openai: mockAdapter("openai"), anthropic: mockAdapter("anthropic") },
    });

    const response = await client.complete({
      model: "gpt-5.2",
      messages: [Msg.user("Hi")],
      provider: "openai",
    });

    expect(response.provider).toBe("openai");
  });

  it("uses default provider when none specified", async () => {
    const client = new Client({
      providers: { anthropic: mockAdapter("anthropic") },
    });

    const response = await client.complete({
      model: "claude-opus-4-6",
      messages: [Msg.user("Hi")],
    });

    expect(response.provider).toBe("anthropic");
  });

  it("throws ConfigurationError for unknown provider", async () => {
    const client = new Client({
      providers: { openai: mockAdapter("openai") },
    });

    await expect(
      client.complete({ model: "test", messages: [Msg.user("Hi")], provider: "unknown" }),
    ).rejects.toThrow(ConfigurationError);
  });

  it("applies middleware in order", async () => {
    const log: string[] = [];

    const mw1 = async (req: Request, next: (r: Request) => Promise<Response>) => {
      log.push("mw1-before");
      const res = await next(req);
      log.push("mw1-after");
      return res;
    };

    const mw2 = async (req: Request, next: (r: Request) => Promise<Response>) => {
      log.push("mw2-before");
      const res = await next(req);
      log.push("mw2-after");
      return res;
    };

    const client = new Client({
      providers: { test: mockAdapter("test") },
      middleware: [mw1, mw2],
    });

    await client.complete({ model: "test", messages: [Msg.user("Hi")] });

    expect(log).toEqual(["mw1-before", "mw2-before", "mw2-after", "mw1-after"]);
  });
});

describe("generate()", () => {
  it("generates with simple prompt", async () => {
    const client = new Client({ providers: { test: mockAdapter("test") } });

    const result = await generate({
      model: "test",
      prompt: "Hello",
      client,
    });

    expect(result.text).toContain("Hello from test");
    expect(result.finish_reason.reason).toBe("stop");
    expect(result.usage.total_tokens).toBeGreaterThan(0);
  });

  it("executes active tools", async () => {
    let toolCalled = false;

    const toolAdapter: ProviderAdapter = {
      name: "test",
      async complete(req) {
        // First call: return tool call
        if (!req.messages.some((m) => m.role === "tool")) {
          return {
            id: "1",
            model: "test",
            provider: "test",
            message: {
              role: "assistant",
              content: [{
                kind: "tool_call",
                tool_call: { id: "call_1", name: "get_weather", arguments: { city: "SF" } },
              }],
            },
            finish_reason: { reason: "tool_calls" },
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          } as Response;
        }
        // Second call: return text
        return {
          id: "2",
          model: "test",
          provider: "test",
          message: { role: "assistant", content: [{ kind: "text", text: "It's sunny in SF!" }] },
          finish_reason: { reason: "stop" },
          usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
        } as Response;
      },
      async *stream() {},
    };

    const client = new Client({ providers: { test: toolAdapter } });

    const weatherTool: ToolDefinition = {
      name: "get_weather",
      description: "Get weather",
      parameters: { type: "object", properties: { city: { type: "string" } } },
      async execute(args) {
        toolCalled = true;
        return `72F and sunny in ${args.city}`;
      },
    };

    const result = await generate({
      model: "test",
      prompt: "What's the weather in SF?",
      tools: [weatherTool],
      max_tool_rounds: 3,
      client,
    });

    expect(toolCalled).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.text).toContain("sunny");
    expect(result.total_usage.total_tokens).toBe(45);
  });
});
