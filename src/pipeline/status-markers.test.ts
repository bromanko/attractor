import { describe, it, expect } from "vitest";
import type { GraphNode } from "./types.js";
import { shouldParseStatusMarkers } from "./status-markers.js";

function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: "n",
    attrs: { label: "Node" },
    ...overrides,
  };
}

describe("shouldParseStatusMarkers", () => {
  // --- Explicit opt-in / opt-out always wins ---

  it("returns true when auto_status=true (boolean)", () => {
    const node = makeNode({ attrs: { label: "X", auto_status: true } });
    expect(shouldParseStatusMarkers(node)).toBe(true);
  });

  it("returns true when auto_status='true' (string)", () => {
    const node = makeNode({ attrs: { label: "X", auto_status: "true" } });
    expect(shouldParseStatusMarkers(node)).toBe(true);
  });

  it("returns false when auto_status=false (boolean)", () => {
    const node = makeNode({ attrs: { label: "X", auto_status: false } });
    expect(shouldParseStatusMarkers(node)).toBe(false);
  });

  it("returns false when auto_status='false' (string)", () => {
    const node = makeNode({ attrs: { label: "X", auto_status: "false" } });
    expect(shouldParseStatusMarkers(node)).toBe(false);
  });

  it("returns false when auto_status=false even for non-box shape", () => {
    const node = makeNode({ attrs: { label: "Gate", shape: "diamond", auto_status: false } });
    expect(shouldParseStatusMarkers(node)).toBe(false);
  });

  it("returns true when auto_status=true even for box shape", () => {
    const node = makeNode({ attrs: { label: "X", shape: "box", auto_status: true } });
    expect(shouldParseStatusMarkers(node)).toBe(true);
  });

  // --- Shape-based defaults (no auto_status) ---

  it("returns false for box shape (codergen default)", () => {
    const node = makeNode({ attrs: { label: "Implement", shape: "box" } });
    expect(shouldParseStatusMarkers(node)).toBe(false);
  });

  it("returns false when shape is unset (defaults to box)", () => {
    const node = makeNode({ attrs: { label: "Implement" } });
    expect(shouldParseStatusMarkers(node)).toBe(false);
  });

  it("returns true for diamond shape", () => {
    const node = makeNode({ attrs: { label: "Gate", shape: "diamond" } });
    expect(shouldParseStatusMarkers(node)).toBe(true);
  });

  it("returns true for ellipse shape", () => {
    const node = makeNode({ attrs: { label: "Check", shape: "ellipse" } });
    expect(shouldParseStatusMarkers(node)).toBe(true);
  });

  it("returns true for other non-box shapes", () => {
    const node = makeNode({ attrs: { label: "Tool", shape: "hexagon" } });
    expect(shouldParseStatusMarkers(node)).toBe(true);
  });
});
