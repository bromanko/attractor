import { describe, it, expect } from "vitest";
import { ToolHandler } from "./handlers.js";
import { Context } from "./types.js";
import type { Graph, GraphNode } from "./types.js";

function makeGraph(): Graph {
  return {
    name: "test",
    attrs: { goal: "test-goal" },
    nodes: [],
    edges: [],
    node_defaults: {},
    edge_defaults: {},
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
