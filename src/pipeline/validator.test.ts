import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validate, validateOrRaise } from "./validator.js";
import { graph } from "./test-graph-builder.js";

describe("Validator", () => {
  function validGraph() {
    return graph({
      attrs: { goal: "Test" },
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "work", shape: "box", prompt: "Do work" },
      ],
      edges: [
        { from: "start", to: "work" },
        { from: "work", to: "exit" },
      ],
    });
  }

  it("validates a correct pipeline with no errors", () => {
    const diags = validate(validGraph());
    const errors = diags.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("detects missing start node", () => {
    const g = graph({
      nodes: [
        { id: "exit", shape: "Msquare" },
        { id: "a", shape: "box" },
      ],
      edges: [{ from: "a", to: "exit" }],
    });
    const diags = validate(g);
    expect(diags.some((d) => d.rule === "start_node")).toBe(true);
  });

  it("detects missing exit node", () => {
    const g = graph({
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "a", shape: "box" },
      ],
      edges: [{ from: "start", to: "a" }],
    });
    const diags = validate(g);
    expect(diags.some((d) => d.rule === "terminal_node")).toBe(true);
  });

  it("detects start with incoming edges", () => {
    const g = graph({
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "a", shape: "box" },
      ],
      edges: [
        { from: "a", to: "start" },
        { from: "start", to: "exit" },
      ],
    });
    const diags = validate(g);
    expect(diags.some((d) => d.rule === "start_no_incoming")).toBe(true);
  });

  it("detects exit with outgoing edges", () => {
    const g = graph({
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "a", shape: "box" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "exit" },
        { from: "exit", to: "a" },
      ],
    });
    const diags = validate(g);
    expect(diags.some((d) => d.rule === "exit_no_outgoing")).toBe(true);
  });

  it("detects unreachable nodes", () => {
    const g = graph({
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "orphan", shape: "box" },
      ],
      edges: [{ from: "start", to: "exit" }],
    });
    const diags = validate(g);
    expect(diags.some((d) => d.rule === "reachability")).toBe(true);
  });

  it("validateOrRaise throws on errors", () => {
    const g = graph({
      nodes: [{ id: "a", shape: "box" }],
      edges: [],
    });
    expect(() => validateOrRaise(g)).toThrow("Pipeline validation failed");
  });

  it("validateOrRaise does not throw on warnings only", () => {
    expect(() => validateOrRaise(validGraph())).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // prompt_file_exists
  // -----------------------------------------------------------------------

  it("warns when prompt_file does not exist", () => {
    const g = graph({
      attrs: { goal: "Test" },
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "review", shape: "box", prompt: "Review", prompt_file: "/nonexistent/review.md" },
      ],
      edges: [
        { from: "start", to: "review" },
        { from: "review", to: "exit" },
      ],
    });
    const diags = validate(g);
    const pf = diags.filter((d) => d.rule === "prompt_file_exists");
    expect(pf).toHaveLength(1);
    expect(pf[0].severity).toBe("warning");
    expect(pf[0].message).toContain("/nonexistent/review.md");
    expect(pf[0].node_id).toBe("review");
    expect(pf[0].fix).toBeDefined();
  });

  it("warns for each missing file in comma-separated prompt_file", () => {
    const g = graph({
      attrs: { goal: "Test" },
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "review", shape: "box", prompt: "Review", prompt_file: "/missing/a.md, /missing/b.md" },
      ],
      edges: [
        { from: "start", to: "review" },
        { from: "review", to: "exit" },
      ],
    });
    const diags = validate(g);
    const pf = diags.filter((d) => d.rule === "prompt_file_exists");
    expect(pf).toHaveLength(2);
    expect(pf[0].message).toContain("/missing/a.md");
    expect(pf[1].message).toContain("/missing/b.md");
  });

  it("does not warn when prompt_file exists", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "val-test-"));
    try {
      await writeFile(join(tmpDir, "skill.md"), "# Review skill");
      const g = graph({
        attrs: { goal: "Test" },
        nodes: [
          { id: "start", shape: "Mdiamond" },
          { id: "exit", shape: "Msquare" },
          { id: "review", shape: "box", prompt: "Review", prompt_file: join(tmpDir, "skill.md") },
        ],
        edges: [
          { from: "start", to: "review" },
          { from: "review", to: "exit" },
        ],
      });
      const diags = validate(g);
      const pf = diags.filter((d) => d.rule === "prompt_file_exists");
      expect(pf).toHaveLength(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not warn when no prompt_file attribute", () => {
    const diags = validate(validGraph());
    const pf = diags.filter((d) => d.rule === "prompt_file_exists");
    expect(pf).toHaveLength(0);
  });

  // failure_path rule
  it("warns when infrastructure node has no failure path", () => {
    const g = graph({
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "ci", shape: "parallelogram", tool_command: "make test" },
        { id: "work", shape: "box" },
      ],
      edges: [
        { from: "start", to: "ci" },
        { from: "ci", to: "work" },
        { from: "work", to: "exit" },
      ],
    });
    const diags = validate(g).filter((d) => d.rule === "failure_path");
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("ci");
  });

  it("no failure_path warning when infra node routes to diamond gate", () => {
    const g = graph({
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "ci", shape: "parallelogram", tool_command: "make test" },
        { id: "gate", shape: "diamond" },
        { id: "fix", shape: "box" },
      ],
      edges: [
        { from: "start", to: "ci" },
        { from: "ci", to: "gate" },
        { from: "gate", to: "exit", condition: "outcome=success" },
        { from: "gate", to: "fix", condition: "outcome!=success" },
        { from: "fix", to: "exit" },
      ],
    });
    const diags = validate(g).filter((d) => d.rule === "failure_path");
    expect(diags).toHaveLength(0);
  });

  it("no failure_path warning when infra node has failure condition edge", () => {
    const g = graph({
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "ci", shape: "parallelogram", tool_command: "make test" },
        { id: "fix", shape: "box" },
      ],
      edges: [
        { from: "start", to: "ci" },
        { from: "ci", to: "exit", condition: "outcome=success" },
        { from: "ci", to: "fix", condition: "outcome!=success" },
        { from: "fix", to: "exit" },
      ],
    });
    const diags = validate(g).filter((d) => d.rule === "failure_path");
    expect(diags).toHaveLength(0);
  });

  it("does not flag LLM nodes for failure_path", () => {
    const g = graph({
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "review", shape: "box", prompt: "Review code" },
      ],
      edges: [
        { from: "start", to: "review" },
        { from: "review", to: "exit" },
      ],
    });
    const diags = validate(g).filter((d) => d.rule === "failure_path");
    expect(diags).toHaveLength(0);
  });

  // conditional_gate_coverage rule
  it("warns when diamond gate only handles success", () => {
    const g = graph({
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "gate", shape: "diamond" },
        { id: "work", shape: "box" },
      ],
      edges: [
        { from: "start", to: "gate" },
        { from: "gate", to: "work", condition: "outcome=success" },
        { from: "work", to: "exit" },
      ],
    });
    const diags = validate(g).filter((d) => d.rule === "conditional_gate_coverage");
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("not failure");
  });

  it("no gate coverage warning when both outcomes handled", () => {
    const g = graph({
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "gate", shape: "diamond" },
        { id: "fix", shape: "box" },
      ],
      edges: [
        { from: "start", to: "gate" },
        { from: "gate", to: "exit", condition: "outcome=success" },
        { from: "gate", to: "fix", condition: "outcome!=success" },
        { from: "fix", to: "exit" },
      ],
    });
    const diags = validate(g).filter((d) => d.rule === "conditional_gate_coverage");
    expect(diags).toHaveLength(0);
  });

  // human_gate_options rule
  it("warns when human gate has fewer than 2 options", () => {
    const g = graph({
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "gate", shape: "hexagon" },
      ],
      edges: [
        { from: "start", to: "gate" },
        { from: "gate", to: "exit" },
      ],
    });
    const diags = validate(g).filter((d) => d.rule === "human_gate_options");
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("1 outgoing");
  });

  it("no human_gate warning when 2+ options present", () => {
    const g = graph({
      nodes: [
        { id: "start", shape: "Mdiamond" },
        { id: "exit", shape: "Msquare" },
        { id: "gate", shape: "hexagon" },
        { id: "a", shape: "box" },
        { id: "b", shape: "box" },
      ],
      edges: [
        { from: "start", to: "gate" },
        { from: "gate", to: "a", label: "Yes" },
        { from: "gate", to: "b", label: "No" },
        { from: "a", to: "exit" },
        { from: "b", to: "exit" },
      ],
    });
    const diags = validate(g).filter((d) => d.rule === "human_gate_options");
    expect(diags).toHaveLength(0);
  });
});
