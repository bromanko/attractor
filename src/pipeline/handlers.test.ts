import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolHandler, WaitForHumanHandler } from "./handlers.js";
import { Context } from "./types.js";
import type { Graph, GraphNode, Interviewer, Question, Answer } from "./types.js";

function makeGraph(overrides: Partial<Graph> = {}): Graph {
  return {
    name: "test",
    attrs: { goal: "test-goal" },
    nodes: [],
    edges: [],
    node_defaults: {},
    edge_defaults: {},
    ...overrides,
  };
}

function makeToolNode(command: string): GraphNode {
  return {
    id: "tool",
    attrs: {
      shape: "parallelogram",
      tool_command: command,
    },
  };
}

function makeHumanNode(attrs: Record<string, unknown> = {}): GraphNode {
  return {
    id: "human_review",
    attrs: {
      shape: "hexagon",
      label: "Review",
      ...attrs,
    },
  };
}

describe("ToolHandler variable expansion", () => {
  it("expands context variables in tool commands", async () => {
    const handler = new ToolHandler();
    const context = new Context();
    context.set("workspace.name", "demo-ws");

    const outcome = await handler.execute(
      makeToolNode("echo \"$workspace.name\""),
      context,
      makeGraph(),
    );

    expect(outcome.status).toBe("success");
    expect(String(outcome.context_updates?.["tool.output"] ?? "").trim()).toBe("demo-ws");
  });

  it("preserves unknown shell variables like $CANDIDATE", async () => {
    const handler = new ToolHandler();
    const context = new Context();

    const outcome = await handler.execute(
      makeToolNode("CANDIDATE=abc123 && echo \"$CANDIDATE\""),
      context,
      makeGraph(),
    );

    expect(outcome.status).toBe("success");
    expect(String(outcome.context_updates?.["tool.output"] ?? "").trim()).toBe("abc123");
  });
});

describe("WaitForHumanHandler", () => {
  it("asks for revision feedback when Revise is selected", async () => {
    const interviewer: Interviewer = {
      async ask(question: Question): Promise<Answer> {
        if (question.type === "multiple_choice") {
          const revise = question.options.find((o) => /revise/i.test(o.label));
          if (!revise) throw new Error("Expected a Revise option in multiple-choice question");
          return { value: revise.key, selected_option: revise };
        }
        return { value: "Need tighter scope.", text: "Need tighter scope." };
      },
    };

    const handler = new WaitForHumanHandler(interviewer);
    const context = new Context();
    const graph = makeGraph({
      edges: [
        { from: "human_review", to: "write_plan", attrs: { label: "Accept" } },
        { from: "human_review", to: "plan_revise", attrs: { label: "Revise" } },
      ],
    });

    const outcome = await handler.execute(makeHumanNode(), context, graph, ".");
    expect(outcome.status).toBe("success");
    expect(outcome.suggested_next_ids).toEqual(["plan_revise"]);
    expect(outcome.context_updates?.["human.gate.feedback"]).toBe("Need tighter scope.");
  });

  it("writes draft plan file when configured", async () => {
    const interviewer: Interviewer = {
      async ask(question: Question): Promise<Answer> {
        if (question.type === "multiple_choice") {
          const accept = question.options.find((o) => /accept/i.test(o.label));
          if (!accept) throw new Error("Expected an Accept option in multiple-choice question");
          return { value: accept.key, selected_option: accept };
        }
        return { value: "" };
      },
    };

    const handler = new WaitForHumanHandler(interviewer);
    const context = new Context();
    const repoRoot = await mkdtemp(join(tmpdir(), "attractor-handlers-"));
    context.set("workspace.repo_root", repoRoot);
    context.set("plan._full_response", "# Draft\n\nPlan body");

    const graph = makeGraph({
      attrs: { goal: "My Test Goal" },
      edges: [
        { from: "human_review", to: "write_plan", attrs: { label: "Accept" } },
      ],
    });

    const node = makeHumanNode({
      draft_context_key: "plan._full_response",
      draft_path: "docs/plans/<slug>.draft.md",
    });

    const outcome = await handler.execute(node, context, graph, ".");
    const draftPath = String(outcome.context_updates?.["human.gate.draft_path"] ?? "");
    expect(draftPath).toContain("docs/plans/my-test-goal.draft.md");

    const content = await readFile(draftPath, "utf-8");
    expect(content).toContain("Plan body");
  });

  it("omits details_markdown when review_markdown_keys is invalid/empty and no defaults exist", async () => {
    const asked: Question[] = [];
    const interviewer: Interviewer = {
      async ask(question: Question): Promise<Answer> {
        asked.push(question);
        const accept = question.options.find((o) => /accept/i.test(o.label));
        if (!accept) throw new Error("Expected an Accept option in multiple-choice question");
        return { value: accept.key, selected_option: accept };
      },
    };

    const handler = new WaitForHumanHandler(interviewer);
    const context = new Context();
    const graph = makeGraph({
      edges: [{ from: "human_review", to: "write_plan", attrs: { label: "Accept" } }],
    });

    // non-string type
    await handler.execute(makeHumanNode({ review_markdown_keys: 123 }), context, graph, ".");
    expect(asked[0]?.details_markdown).toBeUndefined();

    // empty CSV string
    await handler.execute(makeHumanNode({ review_markdown_keys: " ,, " }), context, graph, ".");
    expect(asked[1]?.details_markdown).toBeUndefined();

    // whitespace-only entries
    await handler.execute(makeHumanNode({ review_markdown_keys: "   ,   ,\t" }), context, graph, ".");
    expect(asked[2]?.details_markdown).toBeUndefined();
  });

  it("does not write draft file when configured draft_context_key is empty/whitespace", async () => {
    const interviewer: Interviewer = {
      async ask(question: Question): Promise<Answer> {
        const accept = question.options.find((o) => /accept/i.test(o.label));
        if (!accept) throw new Error("Expected an Accept option in multiple-choice question");
        return { value: accept.key, selected_option: accept };
      },
    };

    const handler = new WaitForHumanHandler(interviewer);
    const context = new Context();
    const repoRoot = await mkdtemp(join(tmpdir(), "attractor-handlers-"));
    context.set("workspace.repo_root", repoRoot);
    context.set("plan._full_response", "   \n\t  ");

    const graph = makeGraph({
      edges: [{ from: "human_review", to: "write_plan", attrs: { label: "Accept" } }],
    });

    const outcome = await handler.execute(
      makeHumanNode({ draft_context_key: "plan._full_response" }),
      context,
      graph,
      ".",
    );

    expect(outcome.context_updates?.["human.gate.draft_path"]).toBeUndefined();

    const defaultDraftDir = join(repoRoot, "docs", "plans");
    await expect(access(defaultDraftDir)).rejects.toBeDefined();
  });

  it("uses default draft path and slug fallback when goal is missing/degenerate", async () => {
    const interviewer: Interviewer = {
      async ask(question: Question): Promise<Answer> {
        const accept = question.options.find((o) => /accept/i.test(o.label));
        if (!accept) throw new Error("Expected an Accept option in multiple-choice question");
        return { value: accept.key, selected_option: accept };
      },
    };

    const handler = new WaitForHumanHandler(interviewer);
    const context = new Context();
    const repoRoot = await mkdtemp(join(tmpdir(), "attractor-handlers-"));
    context.set("workspace.repo_root", repoRoot);
    context.set("plan._full_response", "Fallback slug content");

    const graph = makeGraph({
      attrs: { goal: "!!!" },
      edges: [{ from: "human_review", to: "write_plan", attrs: { label: "Accept" } }],
    });

    const outcome = await handler.execute(makeHumanNode(), context, graph, ".");
    const draftPath = String(outcome.context_updates?.["human.gate.draft_path"] ?? "");
    expect(draftPath).toContain(join("docs", "plans", "plan.draft.md"));

    const content = await readFile(draftPath, "utf-8");
    expect(content).toContain("Fallback slug content");
  });
});
