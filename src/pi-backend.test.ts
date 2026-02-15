/**
 * Tests for PiBackend — the pi SDK-based CodergenBackend.
 *
 * All tests use a _sessionFactory mock to avoid network/auth dependencies.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PiBackend,
  defaultParseOutcome,
  buildContextSummary,
  loadPromptFiles,
  expandPath,
} from "./pi-backend.js";
import { Context, HUMAN_GATE_KEYS } from "./pipeline/types.js";
import type { GraphNode } from "./pipeline/types.js";
import type {
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
  AgentSessionEvent,
  SessionStats,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: "implement",
    attrs: { label: "Implement", prompt: "Write the code" },
    ...overrides,
  };
}

/** Create a minimal mock Model object. */
function mockModel(
  provider = "test-provider",
  id = "test-model",
): Model<Api> {
  return {
    id,
    name: id,
    api: "anthropic" as Api,
    provider: provider as any,
    baseUrl: "https://test.example.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
  };
}

/** Create a mock ModelRegistry that resolves specified models. */
function mockModelRegistry(
  models: Model<Api>[] = [mockModel()],
): ModelRegistry {
  return {
    find: (provider: string, modelId: string) =>
      models.find(
        (m) => m.provider === provider && m.id === modelId,
      ),
    getAvailable: () => models,
    getAll: () => models,
    getApiKey: async () => "test-key",
    getApiKeyForProvider: async () => "test-key",
  } as any;
}

/**
 * Create a mock session factory that captures the options and responds
 * with a fixed assistant text.
 */
function mockSessionFactory(
  responseText: string,
  stats?: Partial<SessionStats>,
) {
  const captured: { opts: CreateAgentSessionOptions | undefined; promptText: string | undefined } = {
    opts: undefined,
    promptText: undefined,
  };

  const factory = async (
    opts: CreateAgentSessionOptions,
  ): Promise<CreateAgentSessionResult> => {
    captured.opts = opts;

    const mockSession = {
      prompt: vi.fn(async (text: string) => {
        captured.promptText = text;
      }),
      getLastAssistantText: vi.fn(() => responseText),
      getSessionStats: vi.fn((): SessionStats => ({
        sessionFile: undefined,
        sessionId: "test-session",
        userMessages: 1,
        assistantMessages: 1,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 2,
        tokens: {
          input: 100,
          output: 200,
          cacheRead: 50,
          cacheWrite: 25,
          total: 375,
        },
        cost: 0.005,
        ...stats,
      })),
      subscribe: vi.fn(() => () => {}),
      dispose: vi.fn(),
    };

    return {
      session: mockSession as any,
      extensionsResult: { extensions: [], errors: [], warnings: [] } as any,
    };
  };

  return { factory, captured };
}

/**
 * Create a PiBackend with a mock session factory and model registry.
 */
function createTestBackend(
  responseText: string,
  configOverrides: Partial<import("./pi-backend.js").PiBackendConfig> = {},
  stats?: Partial<SessionStats>,
) {
  const { factory, captured } = mockSessionFactory(responseText, stats);

  const backend = new PiBackend({
    model: "test-model",
    provider: "test-provider",
    cwd: "/tmp/test",
    modelRegistry: mockModelRegistry(),
    _sessionFactory: factory,
    ...configOverrides,
  });

  return { backend, captured };
}

// ---------------------------------------------------------------------------
// defaultParseOutcome tests
// ---------------------------------------------------------------------------

describe("defaultParseOutcome", () => {
  // Default makeNode() is shape=box (codergen) — status markers are ignored.
  const codergenNode = makeNode();
  // Review node opts in to status marker parsing.
  const reviewNode = makeNode({ id: "review", attrs: { label: "Review", auto_status: true } });
  const ctx = new Context();

  it("defaults to success when no markers present", () => {
    const outcome = defaultParseOutcome("Here is the implementation.", codergenNode, ctx);
    expect(outcome.status).toBe("success");
    expect(outcome.notes).toContain("Here is the implementation.");
    expect(outcome.context_updates!["implement.response"]).toContain("Here is the implementation.");
  });

  // --- auto_status=true nodes honour status markers ---

  it("parses [STATUS: fail] marker for auto_status=true node", () => {
    const outcome = defaultParseOutcome(
      "Could not complete.\n[STATUS: fail]\n[FAILURE_REASON: Missing dependency]",
      reviewNode,
      ctx,
    );
    expect(outcome.status).toBe("fail");
    expect(outcome.failure_reason).toBe("Missing dependency");
  });

  it("parses [STATUS: partial_success] marker for auto_status=true node", () => {
    const outcome = defaultParseOutcome(
      "Mostly done. [STATUS: partial_success]",
      reviewNode,
      ctx,
    );
    expect(outcome.status).toBe("partial_success");
  });

  it("fails auto_status=true node when status marker is missing", () => {
    const outcome = defaultParseOutcome(
      "No status marker here.",
      reviewNode,
      ctx,
    );
    expect(outcome.status).toBe("fail");
    expect(outcome.failure_reason).toBe("Missing [STATUS: ...] marker in response");
  });

  it("fails auto_status=true node with empty response", () => {
    const outcome = defaultParseOutcome(
      "",
      reviewNode,
      ctx,
    );
    expect(outcome.status).toBe("fail");
    expect(outcome.failure_reason).toBe("Missing [STATUS: ...] marker in response");
  });

  // --- codergen nodes (box shape) ignore status markers ---

  it("ignores [STATUS: fail] marker for codergen node (box shape)", () => {
    const outcome = defaultParseOutcome(
      "Could not complete.\n[STATUS: fail]\n[FAILURE_REASON: Missing dependency]",
      codergenNode,
      ctx,
    );
    expect(outcome.status).toBe("success");
    expect(outcome.failure_reason).toBeUndefined();
  });

  it("ignores [STATUS: success] marker for codergen node", () => {
    const outcome = defaultParseOutcome(
      "All done! [STATUS: success]",
      codergenNode,
      ctx,
    );
    expect(outcome.status).toBe("success");
  });

  it("ignores [STATUS: partial_success] marker for codergen node", () => {
    const outcome = defaultParseOutcome(
      "Mostly done. [STATUS: partial_success]",
      codergenNode,
      ctx,
    );
    expect(outcome.status).toBe("success");
  });

  // --- auto_status opt-in for codergen nodes ---

  it("honours status markers when codergen node has auto_status=true", () => {
    const node = makeNode({ attrs: { label: "Review", auto_status: true } });
    const outcome = defaultParseOutcome(
      "Issues found. [STATUS: fail]\n[FAILURE_REASON: Bad code]",
      node,
      ctx,
    );
    expect(outcome.status).toBe("fail");
    expect(outcome.failure_reason).toBe("Bad code");
  });

  it("honours auto_status='true' as string", () => {
    const node = makeNode({ attrs: { label: "Review", auto_status: "true" } });
    const outcome = defaultParseOutcome(
      "Issues found. [STATUS: fail]",
      node,
      ctx,
    );
    expect(outcome.status).toBe("fail");
  });

  it("honours auto_status=false even for non-box shapes", () => {
    const node = makeNode({ attrs: { label: "Gate", shape: "diamond", auto_status: false } });
    const outcome = defaultParseOutcome(
      "Issues found. [STATUS: fail]",
      node,
      ctx,
    );
    expect(outcome.status).toBe("success");
  });

  it("honours auto_status='false' as string for non-box shapes", () => {
    const node = makeNode({ attrs: { label: "Gate", shape: "diamond", auto_status: "false" } });
    const outcome = defaultParseOutcome("Issues found. [STATUS: fail]", node, ctx);
    expect(outcome.status).toBe("success");
    expect(outcome.failure_reason).toBeUndefined();
  });

  it("honours status markers by default for non-box shapes (e.g., ellipse)", () => {
    const node = makeNode({ attrs: { label: "Check", shape: "ellipse" } });
    const outcome = defaultParseOutcome("Issues found. [STATUS: fail]", node, ctx);
    expect(outcome.status).toBe("fail");
  });

  // --- routing markers always parsed regardless of auto_status ---

  it("parses [PREFERRED_LABEL: ...] for routing", () => {
    const outcome = defaultParseOutcome(
      "Tests passed!\n[STATUS: success]\n[PREFERRED_LABEL: Yes]",
      codergenNode,
      ctx,
    );
    expect(outcome.preferred_label).toBe("Yes");
  });

  it("parses routing markers alongside status markers on reviewNode", () => {
    const outcome = defaultParseOutcome(
      "Looks good!\n[STATUS: success]\n[PREFERRED_LABEL: Yes]",
      reviewNode,
      ctx,
    );
    expect(outcome.status).toBe("success");
    expect(outcome.preferred_label).toBe("Yes");
  });

  it("parses [NEXT: node_id] for suggested routing", () => {
    const outcome = defaultParseOutcome(
      "Done. [NEXT: deploy] [NEXT: notify]",
      codergenNode,
      ctx,
    );
    expect(outcome.suggested_next_ids).toEqual(["deploy", "notify"]);
  });

  it("uses response text as failure_reason when no FAILURE_REASON marker (auto_status=true)", () => {
    const outcome = defaultParseOutcome(
      "Failed to compile. [STATUS: fail]",
      reviewNode,
      ctx,
    );
    expect(outcome.status).toBe("fail");
    expect(outcome.failure_reason).toContain("Failed to compile");
  });

  it("truncates long notes and response", () => {
    const longText = "x".repeat(3000);
    const outcome = defaultParseOutcome(longText, codergenNode, ctx);
    expect(outcome.notes!.length).toBeLessThanOrEqual(500);
    expect((outcome.context_updates!["implement.response"] as string).length).toBeLessThanOrEqual(2000);
  });
});

// ---------------------------------------------------------------------------
// buildContextSummary tests
// ---------------------------------------------------------------------------

describe("buildContextSummary", () => {
  it("returns empty string for empty context", () => {
    const ctx = new Context();
    expect(buildContextSummary(ctx)).toBe("");
  });

  it("includes context values", () => {
    const ctx = new Context();
    ctx.set("plan.steps", "1. Create file\n2. Write tests");
    const summary = buildContextSummary(ctx);
    expect(summary).toContain("plan.steps");
    expect(summary).toContain("Create file");
  });

  it("excludes keys starting with _", () => {
    const ctx = new Context();
    ctx.set("_internal", "secret");
    ctx.set("visible", "value");
    const summary = buildContextSummary(ctx);
    expect(summary).not.toContain("_internal");
    expect(summary).toContain("visible");
  });

  it("includes workspace instructions when workspace.path is set", () => {
    const ctx = new Context();
    ctx.set("workspace.path", "/tmp/ws");
    const summary = buildContextSummary(ctx);
    expect(summary).toContain("/tmp/ws");
    expect(summary).toContain("jj workspace");
  });

  it("gives response keys generous truncation limit", () => {
    const ctx = new Context();
    const longResponse = "x".repeat(3000);
    ctx.set("plan_review.response", longResponse);
    const summary = buildContextSummary(ctx);
    // Should include most of the 3000-char response (limit is 4000)
    expect(summary).toContain("x".repeat(3000));
  });

  it("gives feedback keys generous truncation limit", () => {
    const ctx = new Context();
    const longFeedback = "y".repeat(3500);
    ctx.set(HUMAN_GATE_KEYS.FEEDBACK, longFeedback);
    const summary = buildContextSummary(ctx);
    expect(summary).toContain("y".repeat(3500));
  });

  it("truncates non-response keys at 200 chars", () => {
    const ctx = new Context();
    const longUsage = "z".repeat(500);
    ctx.set("plan.usage.input_tokens", longUsage);
    const summary = buildContextSummary(ctx);
    expect(summary).not.toContain("z".repeat(500));
    expect(summary).toContain("z".repeat(200));
  });
});

// ---------------------------------------------------------------------------
// expandPath tests
// ---------------------------------------------------------------------------

describe("expandPath", () => {
  it("resolves ~/ to home directory", () => {
    const result = expandPath("~/docs/file.md");
    expect(result).not.toContain("~");
    expect(result).toContain("docs/file.md");
  });

  it("leaves absolute paths unchanged", () => {
    expect(expandPath("/usr/local/file.md")).toBe("/usr/local/file.md");
  });
});

// ---------------------------------------------------------------------------
// loadPromptFiles tests
// ---------------------------------------------------------------------------

describe("loadPromptFiles", () => {
  it("returns empty string when no prompt_file attribute", async () => {
    const result = await loadPromptFiles(makeNode());
    expect(result).toBe("");
  });

  it("loads a single prompt_file", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "pf-test-"));
    try {
      await writeFile(join(tmpDir, "review.md"), "# Review Checklist\n- Check types");
      const node = makeNode({
        attrs: { label: "Review", prompt_file: join(tmpDir, "review.md") },
      });
      const result = await loadPromptFiles(node);
      expect(result).toContain("Review Checklist");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("loads multiple comma-separated prompt_files", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "pf-test-"));
    try {
      await writeFile(join(tmpDir, "a.md"), "FILE_A");
      await writeFile(join(tmpDir, "b.md"), "FILE_B");
      const node = makeNode({
        attrs: {
          label: "Review",
          prompt_file: `${join(tmpDir, "a.md")}, ${join(tmpDir, "b.md")}`,
        },
      });
      const result = await loadPromptFiles(node);
      expect(result).toContain("FILE_A");
      expect(result).toContain("FILE_B");
      expect(result.indexOf("FILE_A")).toBeLessThan(result.indexOf("FILE_B"));
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws when prompt_file does not exist", async () => {
    const node = makeNode({
      attrs: { label: "Review", prompt_file: "/nonexistent/file.md" },
    });
    await expect(loadPromptFiles(node)).rejects.toThrow(/Failed to read prompt_file/);
  });
});

// ---------------------------------------------------------------------------
// PiBackend integration tests (using mock session factory)
// ---------------------------------------------------------------------------

describe("PiBackend", () => {
  it("returns success outcome for normal response", async () => {
    const { backend } = createTestBackend("Here is the implementation.");
    const outcome = await backend.run(
      makeNode(),
      "Write the code",
      new Context(),
    );

    expect(outcome.status).toBe("success");
    expect(outcome.notes).toContain("Here is the implementation.");
    expect(outcome.context_updates!["implement.response"]).toContain("Here is the implementation.");
  });

  it("attaches usage metadata from session stats", async () => {
    const { backend } = createTestBackend("Done.", {}, {
      tokens: { input: 100, output: 200, cacheRead: 50, cacheWrite: 25, total: 375 },
      cost: 0.005,
    });
    const outcome = await backend.run(makeNode(), "Implement", new Context());

    expect(outcome.context_updates!["implement.usage.input_tokens"]).toBe(100);
    expect(outcome.context_updates!["implement.usage.output_tokens"]).toBe(200);
    expect(outcome.context_updates!["implement.usage.total_tokens"]).toBe(375);
    expect(outcome.context_updates!["implement.usage.cache_read_tokens"]).toBe(50);
    expect(outcome.context_updates!["implement.usage.cache_write_tokens"]).toBe(25);
    expect(outcome.context_updates!["implement.usage.cost"]).toBe(0.005);
  });

  it("parses status markers from response for auto_status=true node", async () => {
    const { backend } = createTestBackend(
      "I couldn't do it.\n[STATUS: fail]\n[FAILURE_REASON: Missing dependency]",
    );
    const reviewNode = makeNode({ id: "review", attrs: { label: "Review", auto_status: true } });
    const outcome = await backend.run(reviewNode, "Do it", new Context());

    expect(outcome.status).toBe("fail");
    expect(outcome.failure_reason).toBe("Missing dependency");
  });

  it("ignores status markers for codergen node (default auto_status)", async () => {
    const { backend } = createTestBackend(
      "I couldn't do it.\n[STATUS: fail]\n[FAILURE_REASON: Missing dependency]",
    );
    const outcome = await backend.run(makeNode(), "Do it", new Context());

    expect(outcome.status).toBe("success");
  });

  it("uses custom parseOutcome", async () => {
    const { backend } = createTestBackend("LGTM 👍", {
      parseOutcome: (text, node) => ({
        status: text.includes("LGTM") ? "success" : "fail",
        notes: `Custom: ${node.id}`,
      }),
    });
    const outcome = await backend.run(makeNode(), "Review", new Context());

    expect(outcome.status).toBe("success");
    expect(outcome.notes).toBe("Custom: implement");
  });

  it("uses per-node llm_model and llm_provider overrides (model not found)", async () => {
    // The per-node override specifies a provider/model that won't be in
    // the mock registry and is not a built-in pi model → model not found
    const { backend } = createTestBackend("ok");
    const node = makeNode({
      attrs: {
        label: "Special",
        llm_model: "nonexistent-model-xyz",
        llm_provider: "nonexistent-provider",
      },
    });

    const outcome = await backend.run(node, "Do it", new Context());

    expect(outcome.status).toBe("fail");
    expect(outcome.failure_reason).toContain("nonexistent-provider/nonexistent-model-xyz");
  });

  it("resolves per-node overrides when model exists in registry", async () => {
    const opusModel = mockModel("anthropic", "claude-opus-4-6");
    const { factory, captured } = mockSessionFactory("opus response");
    const backend = new PiBackend({
      model: "test-model",
      provider: "test-provider",
      cwd: "/tmp/test",
      modelRegistry: mockModelRegistry([mockModel(), opusModel]),
      _sessionFactory: factory,
    });

    const node = makeNode({
      attrs: {
        label: "Special",
        llm_model: "claude-opus-4-6",
        llm_provider: "anthropic",
      },
    });

    const outcome = await backend.run(node, "Do it", new Context());
    expect(outcome.status).toBe("success");
    expect((captured.opts!.model! as any).id).toBe("claude-opus-4-6");
  });

  it("includes pipeline context in prompt", async () => {
    const { backend, captured } = createTestBackend("ok");
    const context = new Context();
    context.set("plan.steps", "1. Create file\n2. Write tests");

    await backend.run(makeNode(), "Implement the plan", context);

    expect(captured.promptText).toContain("plan.steps");
    expect(captured.promptText).toContain("Implement the plan");
  });

  it("prepends prompt file content to prompt", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "pf-test-"));
    try {
      await writeFile(join(tmpDir, "review.md"), "# Review Checklist");

      const { backend, captured } = createTestBackend("ok");
      const node = makeNode({
        attrs: {
          label: "Review",
          prompt_file: join(tmpDir, "review.md"),
          prompt: "Review the code",
        },
      });

      await backend.run(node, "Review the code", new Context());

      expect(captured.promptText).toContain("Review Checklist");
      expect(captured.promptText).toContain("Review the code");
      expect(captured.promptText!.indexOf("Review Checklist")).toBeLessThan(
        captured.promptText!.indexOf("Review the code"),
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("passes system prompt through resource loader", async () => {
    const { backend, captured } = createTestBackend("ok", {
      systemPrompt: "You are a senior engineer.",
    });

    await backend.run(makeNode(), "Code it", new Context());

    // Verify the resource loader was configured with systemPromptOverride
    expect(captured.opts!.resourceLoader).toBeDefined();
    const loader = captured.opts!.resourceLoader!;
    expect(loader.getSystemPrompt()).toBe("You are a senior engineer.");
  });

  it("uses workspace.path as cwd when present", async () => {
    const { backend, captured } = createTestBackend("ok");
    const context = new Context();
    context.set("workspace.path", "/tmp/workspace");

    await backend.run(makeNode(), "Do it", context);

    expect(captured.opts!.cwd).toBe("/tmp/workspace");
  });

  it("falls back to config.cwd when no workspace.path", async () => {
    const { backend, captured } = createTestBackend("ok", {
      cwd: "/my/project",
    });

    await backend.run(makeNode(), "Do it", new Context());

    expect(captured.opts!.cwd).toBe("/my/project");
  });

  it("configures toolMode=coding by default", async () => {
    const { backend, captured } = createTestBackend("ok");
    await backend.run(makeNode(), "Code", new Context());

    // Default coding tools: read, bash, edit, write
    const toolNames = captured.opts!.tools!.map((t: any) => t.name);
    expect(toolNames).toContain("read");
    expect(toolNames).toContain("bash");
    expect(toolNames).toContain("edit");
    expect(toolNames).toContain("write");
  });

  it("configures toolMode=none", async () => {
    const { backend, captured } = createTestBackend("ok", {
      toolMode: "none",
    });
    await backend.run(makeNode(), "Think", new Context());

    expect(captured.opts!.tools).toEqual([]);
  });

  it("configures toolMode=read-only", async () => {
    const { backend, captured } = createTestBackend("ok", {
      toolMode: "read-only",
    });
    await backend.run(makeNode(), "Analyze", new Context());

    const toolNames = captured.opts!.tools!.map((t: any) => t.name);
    expect(toolNames).toContain("read");
    expect(toolNames).not.toContain("bash");
    expect(toolNames).not.toContain("edit");
    expect(toolNames).not.toContain("write");
  });

  it("suppresses AGENTS.md via resource loader", async () => {
    const { backend, captured } = createTestBackend("ok");
    await backend.run(makeNode(), "Code", new Context());

    const loader = captured.opts!.resourceLoader!;
    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
  });

  it("disables compaction via settings manager", async () => {
    const { backend, captured } = createTestBackend("ok");
    await backend.run(makeNode(), "Code", new Context());

    expect(captured.opts!.settingsManager).toBeDefined();
    const settings = captured.opts!.settingsManager!;
    expect(settings.getCompactionEnabled()).toBe(false);
  });

  it("handles LLM errors gracefully", async () => {
    // Override the factory to throw
    const errorFactory = async () => {
      throw new Error("API rate limit exceeded");
    };

    const backend = new PiBackend({
      model: "test-model",
      provider: "test-provider",
      cwd: "/tmp/test",
      modelRegistry: mockModelRegistry(),
      _sessionFactory: errorFactory,
    });

    const outcome = await backend.run(makeNode(), "Code", new Context());

    expect(outcome.status).toBe("fail");
    expect(outcome.failure_reason).toContain("API rate limit exceeded");
  });

  it("disposes session even on error", async () => {
    const disposeSpy = vi.fn();
    const promptSpy = vi.fn(async () => {
      throw new Error("Boom");
    });

    const factory = async (opts: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => ({
      session: {
        prompt: promptSpy,
        getLastAssistantText: vi.fn(() => ""),
        getSessionStats: vi.fn(() => ({
          sessionFile: undefined,
          sessionId: "test",
          userMessages: 0,
          assistantMessages: 0,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: 0,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: 0,
        })),
        subscribe: vi.fn(() => () => {}),
        dispose: disposeSpy,
      } as any,
      extensionsResult: { extensions: [], errors: [], warnings: [] } as any,
    });

    const backend = new PiBackend({
      model: "test-model",
      provider: "test-provider",
      cwd: "/tmp/test",
      modelRegistry: mockModelRegistry(),
      _sessionFactory: factory,
    });

    await backend.run(makeNode(), "Code", new Context());

    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("bridges events to onStageEvent callback", async () => {
    const events: Array<{ nodeId: string; event: AgentSessionEvent }> = [];

    const subscribeFn = vi.fn((listener: (event: AgentSessionEvent) => void) => {
      // Simulate an event
      listener({ type: "agent_start" } as AgentSessionEvent);
      return () => {};
    });

    const factory = async (opts: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => ({
      session: {
        prompt: vi.fn(async () => {}),
        getLastAssistantText: vi.fn(() => "ok"),
        getSessionStats: vi.fn(() => ({
          sessionFile: undefined,
          sessionId: "test",
          userMessages: 1,
          assistantMessages: 1,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: 2,
          tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 },
          cost: 0.001,
        })),
        subscribe: subscribeFn,
        dispose: vi.fn(),
      } as any,
      extensionsResult: { extensions: [], errors: [], warnings: [] } as any,
    });

    const backend = new PiBackend({
      model: "test-model",
      provider: "test-provider",
      cwd: "/tmp/test",
      modelRegistry: mockModelRegistry(),
      _sessionFactory: factory,
      onStageEvent: (nodeId, event) => {
        events.push({ nodeId, event });
      },
    });

    await backend.run(makeNode(), "Code", new Context());

    expect(events.length).toBe(1);
    expect(events[0].nodeId).toBe("implement");
    expect(events[0].event.type).toBe("agent_start");
  });

  it("passes reasoning_effort as thinkingLevel", async () => {
    const { backend, captured } = createTestBackend("ok");
    const node = makeNode({
      attrs: { label: "Deep thought", reasoning_effort: "high" },
    });

    await backend.run(node, "Think deeply", new Context());

    expect(captured.opts!.thinkingLevel).toBe("high");
  });

  it("warns and uses default for invalid reasoning_effort", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { backend, captured } = createTestBackend("ok");
    const node = makeNode({
      attrs: { label: "Node", reasoning_effort: "super_ultra" },
    });

    await backend.run(node, "Do it", new Context());

    expect(captured.opts!.thinkingLevel).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("super_ultra"),
    );

    warnSpy.mockRestore();
  });

  it("returns success when getLastAssistantText returns empty (no failure marker)", async () => {
    const { backend } = createTestBackend("");
    const outcome = await backend.run(makeNode(), "Do it", new Context());

    // Empty response still parses as success (no failure marker)
    expect(outcome.status).toBe("success");
  });
});

// ---------------------------------------------------------------------------
// PiBackend cancellation tests
// ---------------------------------------------------------------------------

describe("PiBackend cancellation", () => {
  it("pre-aborted signal returns cancelled outcome", async () => {
    const { backend } = createTestBackend("This should not be reached");
    const controller = new AbortController();
    controller.abort();

    const outcome = await backend.run(
      makeNode(),
      "Code it",
      new Context(),
      { signal: controller.signal },
    );

    expect(outcome.status).toBe("cancelled");
    expect(outcome.failure_reason).toContain("Cancelled");
  });

  it("mid-flight abort triggers cancel/dispose path", async () => {
    const disposeSpy = vi.fn();
    let resolvePrompt: (() => void) | undefined;

    const factory = async (opts: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => ({
      session: {
        prompt: vi.fn(() => new Promise<void>((resolve) => {
          resolvePrompt = resolve;
        })),
        getLastAssistantText: vi.fn(() => "ok"),
        getSessionStats: vi.fn(() => ({
          sessionFile: undefined,
          sessionId: "test",
          userMessages: 1,
          assistantMessages: 1,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: 2,
          tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 },
          cost: 0.001,
        })),
        subscribe: vi.fn(() => () => {}),
        dispose: disposeSpy,
      } as any,
      extensionsResult: { extensions: [], errors: [], warnings: [] } as any,
    });

    const backend = new PiBackend({
      model: "test-model",
      provider: "test-provider",
      cwd: "/tmp/test",
      modelRegistry: mockModelRegistry(),
      _sessionFactory: factory,
    });

    const controller = new AbortController();

    // Run in background and abort mid-flight
    const resultPromise = backend.run(
      makeNode(),
      "Code it",
      new Context(),
      { signal: controller.signal },
    );

    // Let the prompt start then abort
    await new Promise(r => setTimeout(r, 10));
    controller.abort();
    // Resolve the prompt so it completes
    resolvePrompt?.();

    const outcome = await resultPromise;

    expect(outcome.status).toBe("cancelled");
    // dispose should have been called (at least once from abort handler or finally)
    expect(disposeSpy).toHaveBeenCalled();
  });

  it("no duplicate disposal — dispose called exactly once on normal flow", async () => {
    const disposeSpy = vi.fn();
    const factory = async (opts: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => ({
      session: {
        prompt: vi.fn(async () => {}),
        getLastAssistantText: vi.fn(() => "ok"),
        getSessionStats: vi.fn(() => ({
          sessionFile: undefined,
          sessionId: "test",
          userMessages: 1,
          assistantMessages: 1,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: 2,
          tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 },
          cost: 0.001,
        })),
        subscribe: vi.fn(() => () => {}),
        dispose: disposeSpy,
      } as any,
      extensionsResult: { extensions: [], errors: [], warnings: [] } as any,
    });

    const backend = new PiBackend({
      model: "test-model",
      provider: "test-provider",
      cwd: "/tmp/test",
      modelRegistry: mockModelRegistry(),
      _sessionFactory: factory,
    });

    await backend.run(makeNode(), "Code", new Context());

    // Should dispose exactly once in the finally block (no abort handler called)
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("listener cleanup is verified — abort handler removed after normal completion", async () => {
    const { backend } = createTestBackend("ok");
    const controller = new AbortController();

    const addSpy = vi.spyOn(controller.signal, "addEventListener");
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

    await backend.run(makeNode(), "Code", new Context(), { signal: controller.signal });

    // Should have added and then removed the abort listener
    expect(addSpy).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
