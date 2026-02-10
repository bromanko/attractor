import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderBanner, renderSummary, renderResumeInfo, renderMarkdown, renderFailureSummary, formatDuration, Spinner } from "./cli-renderer.js";

// ---------------------------------------------------------------------------
// renderBanner
// ---------------------------------------------------------------------------

describe("renderBanner", () => {
  it("renders a banner with all fields", () => {
    const banner = renderBanner({
      goal: "Implement feature X",
      defaultModel: "claude-opus-4-6",
      toolMode: "coding",
      nodeCount: 12,
    });

    expect(banner).toContain("Attractor Pipeline");
    expect(banner).toContain("Implement feature X");
    expect(banner).toContain("Default model:");
    expect(banner).toContain("claude-opus-4-6");
    expect(banner).toContain("coding");
    expect(banner).toContain("12");
  });

  it("labels the model as 'Default model' not just 'Model'", () => {
    const banner = renderBanner({
      goal: "Test",
      defaultModel: "gpt-5.3-codex",
      toolMode: "read-only",
      nodeCount: 3,
    });
    expect(banner).toContain("Default model:");
    // Should NOT have just "Model:" without "Default"
    expect(banner).not.toMatch(/[^t] model:/i);
  });

  it("has consistent box-drawing border widths", () => {
    const banner = renderBanner({
      goal: "Short goal",
      defaultModel: "claude-opus-4-6",
      toolMode: "coding",
      nodeCount: 5,
    });

    // Strip ANSI codes for width checking
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
    const lines = banner.split("\n").filter((l) => l.trim());

    // All lines with box characters should have the same visible width
    const boxLines = lines.filter((l) => {
      const stripped = stripAnsi(l).trim();
      return stripped.startsWith("┌") || stripped.startsWith("│") ||
             stripped.startsWith("└") || stripped.startsWith("├");
    });

    expect(boxLines.length).toBeGreaterThan(0);

    const widths = boxLines.map((l) => stripAnsi(l).trim().length);
    const expectedWidth = widths[0];
    for (const w of widths) {
      expect(w).toBe(expectedWidth);
    }
  });

  it("truncates long goals", () => {
    const longGoal = "A".repeat(100);
    const banner = renderBanner({
      goal: longGoal,
      defaultModel: "model",
      toolMode: "coding",
      nodeCount: 1,
    });
    // Should contain truncation indicator
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
    const stripped = stripAnsi(banner);
    // The goal line shouldn't exceed the box width
    const boxLines = stripped.split("\n").filter((l) => l.trim().startsWith("│"));
    for (const line of boxLines) {
      expect(line.trim().length).toBeLessThanOrEqual(60); // innerWidth + borders + padding
    }
  });
});

// ---------------------------------------------------------------------------
// renderMarkdown
// ---------------------------------------------------------------------------

describe("renderMarkdown", () => {
  it("renders headings", () => {
    const result = renderMarkdown("# Hello World");
    // Should contain the text, possibly with ANSI formatting
    expect(result).toContain("Hello World");
  });

  it("renders code blocks", () => {
    const result = renderMarkdown("```\nconst x = 1;\n```");
    expect(result).toContain("const x = 1");
  });

  it("renders bullet lists", () => {
    const result = renderMarkdown("- Item one\n- Item two");
    expect(result).toContain("Item one");
    expect(result).toContain("Item two");
  });

  it("returns raw text on empty input", () => {
    const result = renderMarkdown("");
    expect(result).toBe("");
  });

  it("handles plain text without markdown", () => {
    const result = renderMarkdown("Just plain text");
    expect(result).toContain("Just plain text");
  });
});

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe("formatDuration", () => {
  it("formats seconds", () => {
    expect(formatDuration(5000)).toBe("5s");
    expect(formatDuration(45000)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(125_000)).toBe("2m 5s");
  });

  it("formats hours", () => {
    expect(formatDuration(3_661_000)).toBe("1h 1m 1s");
  });

  it("formats zero", () => {
    expect(formatDuration(0)).toBe("0s");
  });
});

// ---------------------------------------------------------------------------
// renderSummary
// ---------------------------------------------------------------------------

describe("renderSummary", () => {
  it("renders success summary", () => {
    const summary = renderSummary({
      status: "success",
      completedNodes: ["start", "plan", "exit"],
      logsRoot: "/tmp/logs",
      elapsedMs: 5000,
    });

    expect(summary).toContain("success");
    expect(summary).toContain("start");
    expect(summary).toContain("plan");
    expect(summary).toContain("exit");
    expect(summary).toContain("/tmp/logs");
    expect(summary).toContain("5s");
  });

  it("renders failure summary", () => {
    const summary = renderSummary({
      status: "fail",
      completedNodes: ["start", "plan"],
      logsRoot: "/tmp/logs",
      elapsedMs: 120_000,
    });

    expect(summary).toContain("fail");
    expect(summary).toContain("2m 0s");
  });
});

// ---------------------------------------------------------------------------
// renderResumeInfo
// ---------------------------------------------------------------------------

describe("renderResumeInfo", () => {
  it("renders resume information", () => {
    const info = renderResumeInfo(
      { current_node: "implement", completed_nodes: ["start", "plan"] },
      "implement",
    );

    expect(info).toContain("Resuming from:");
    expect(info).toContain("implement");
    expect(info).toContain("start → plan");
  });
});

// ---------------------------------------------------------------------------
// renderFailureSummary
// ---------------------------------------------------------------------------

describe("renderFailureSummary", () => {
  it("renders all failure summary fields", () => {
    const output = renderFailureSummary({
      failedNode: "selfci_check",
      failureClass: "exit_nonzero",
      digest: "3 failed, 12 passed, 15 total",
      firstFailingCheck: "src/auth.test.ts > should validate tokens",
      rerunCommand: "npm test",
      logsPath: "/tmp/logs/selfci_check/attempt-1",
    });

    expect(output).toContain("Failure Summary");
    expect(output).toContain("selfci_check");
    expect(output).toContain("exit_nonzero");
    expect(output).toContain("3 failed, 12 passed, 15 total");
    expect(output).toContain("src/auth.test.ts > should validate tokens");
    expect(output).toContain("npm test");
    expect(output).toContain("/tmp/logs/selfci_check/attempt-1");
  });

  it("omits optional fields when not present", () => {
    const output = renderFailureSummary({
      failedNode: "build",
      failureClass: "timeout",
      digest: "Timed out: cargo build",
    });

    expect(output).toContain("Failure Summary");
    expect(output).toContain("build");
    expect(output).toContain("timeout");
    expect(output).not.toContain("Check:");
    expect(output).not.toContain("Rerun:");
    expect(output).not.toContain("Logs:");
  });
});

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

describe("Spinner", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    writeSpy.mockRestore();
    vi.useRealTimers();
  });

  it("starts and stops with success", () => {
    const spinner = new Spinner();
    spinner.start("test-stage");

    // Should have written the initial render
    expect(writeSpy).toHaveBeenCalled();

    // Advance timer to trigger a few frames
    vi.advanceTimersByTime(240);
    const callCount = writeSpy.mock.calls.length;
    expect(callCount).toBeGreaterThan(1);

    spinner.stop("success");

    // Should have written the success line
    const lastCalls = writeSpy.mock.calls.slice(-2).map((c) => String(c[0]));
    const joined = lastCalls.join("");
    expect(joined).toContain("✔");
    expect(joined).toContain("test-stage");
  });

  it("starts and stops with failure", () => {
    const spinner = new Spinner();
    spinner.start("failing-stage");
    spinner.stop("fail", "something broke");

    const lastCalls = writeSpy.mock.calls.slice(-2).map((c) => String(c[0]));
    const joined = lastCalls.join("");
    expect(joined).toContain("✘");
    expect(joined).toContain("something broke");
  });

  it("shows model tag when provided", () => {
    const spinner = new Spinner();
    spinner.start("review-stage", "gpt-5.3-codex");

    // Initial render should contain the model
    const firstWrite = String(writeSpy.mock.calls[0][0]);
    expect(firstWrite).toContain("gpt-5.3-codex");

    spinner.stop("success");
    const lastCalls = writeSpy.mock.calls.slice(-2).map((c) => String(c[0]));
    const joined = lastCalls.join("");
    expect(joined).toContain("gpt-5.3-codex");
  });

  it("shows elapsed time", () => {
    const spinner = new Spinner();
    spinner.start("slow-stage");

    // Advance by 5 seconds
    vi.advanceTimersByTime(5000);
    spinner.stop("success");

    const lastCalls = writeSpy.mock.calls.slice(-2).map((c) => String(c[0]));
    const joined = lastCalls.join("");
    expect(joined).toContain("5s");
  });

  it("does not show model tag when not provided", () => {
    const spinner = new Spinner();
    spinner.start("basic-stage");
    spinner.stop("success");

    const allOutput = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    // Should not have bracket model notation
    expect(allOutput).not.toMatch(/\[[a-z]+-[a-z0-9.-]+\]/);
  });
});
