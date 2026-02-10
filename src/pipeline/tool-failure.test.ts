import { describe, it, expect } from "vitest";
import {
  classifyFailure,
  extractTail,
  buildDigest,
  extractFirstFailingCheck,
  extractSelfciDigest,
  isSelfciCommand,
} from "./tool-failure.js";

// ---------------------------------------------------------------------------
// classifyFailure
// ---------------------------------------------------------------------------

describe("classifyFailure", () => {
  it("classifies timeout when killed is true", () => {
    const err = Object.assign(new Error("timeout"), { killed: true, signal: "SIGTERM" });
    expect(classifyFailure(err)).toBe("timeout");
  });

  it("classifies timeout when signal is SIGTERM", () => {
    const err = Object.assign(new Error("timeout"), { signal: "SIGTERM" });
    expect(classifyFailure(err)).toBe("timeout");
  });

  it("classifies spawn_error for ENOENT", () => {
    const err = Object.assign(new Error("spawn error"), { code: "ENOENT" });
    expect(classifyFailure(err)).toBe("spawn_error");
  });

  it("classifies spawn_error for EACCES", () => {
    const err = Object.assign(new Error("spawn error"), { code: "EACCES" });
    expect(classifyFailure(err)).toBe("spawn_error");
  });

  it("classifies exit_nonzero for generic errors", () => {
    const err = Object.assign(new Error("exit 1"), { code: 1 });
    expect(classifyFailure(err)).toBe("exit_nonzero");
  });

  it("classifies exit_nonzero when no code/signal", () => {
    expect(classifyFailure(new Error("something failed"))).toBe("exit_nonzero");
  });
});

// ---------------------------------------------------------------------------
// extractTail
// ---------------------------------------------------------------------------

describe("extractTail", () => {
  it("returns empty for empty input", () => {
    expect(extractTail("")).toBe("");
  });

  it("returns full text when shorter than limits", () => {
    expect(extractTail("line1\nline2")).toBe("line1\nline2");
  });

  it("returns last N lines", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`).join("\n");
    const tail = extractTail(lines, 5);
    expect(tail.split("\n")).toHaveLength(5);
    expect(tail).toContain("line-49");
    expect(tail).not.toContain("line-0");
  });

  it("caps at maxChars", () => {
    const lines = Array.from({ length: 100 }, () => "x".repeat(100)).join("\n");
    const tail = extractTail(lines, 100, 200);
    expect(tail.length).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// isSelfciCommand
// ---------------------------------------------------------------------------

describe("isSelfciCommand", () => {
  it("matches selfci command", () => {
    expect(isSelfciCommand("selfci run")).toBe(true);
  });

  it("matches npm test", () => {
    expect(isSelfciCommand("npm test")).toBe(true);
  });

  it("matches npm run test", () => {
    expect(isSelfciCommand("npm run test")).toBe(true);
  });

  it("matches vitest", () => {
    expect(isSelfciCommand("npx vitest run")).toBe(true);
  });

  it("matches jest", () => {
    expect(isSelfciCommand("npx jest")).toBe(true);
  });

  it("does not match unrelated commands", () => {
    expect(isSelfciCommand("jj commit -m 'fix'")).toBe(false);
    expect(isSelfciCommand("cargo build")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractFirstFailingCheck
// ---------------------------------------------------------------------------

describe("extractFirstFailingCheck", () => {
  it("extracts from vitest FAIL pattern", () => {
    const stdout = `
 ✓ src/a.test.ts
 FAIL  src/b.test.ts > suite > should work
    `;
    expect(extractFirstFailingCheck(stdout, "")).toBe("src/b.test.ts > suite > should work");
  });

  it("extracts from jest ● pattern", () => {
    const stderr = "● Auth > should validate tokens";
    expect(extractFirstFailingCheck("", stderr)).toBe("Auth > should validate tokens");
  });

  it("extracts from TAP not ok pattern", () => {
    const stdout = "not ok 3 - should handle errors";
    expect(extractFirstFailingCheck(stdout, "")).toBe("should handle errors");
  });

  it("extracts from FAILED: prefix", () => {
    const stderr = "FAILED: build step compile";
    expect(extractFirstFailingCheck("", stderr)).toBe("build step compile");
  });

  it("returns undefined when no pattern matches", () => {
    expect(extractFirstFailingCheck("all good", "no errors")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// extractSelfciDigest
// ---------------------------------------------------------------------------

describe("extractSelfciDigest", () => {
  it("extracts Tests summary line", () => {
    const stdout = `
Tests:  3 failed, 12 passed, 15 total
Time:   4.2s
    `;
    expect(extractSelfciDigest(stdout, "")).toBe("3 failed, 12 passed, 15 total");
  });

  it("extracts N failing pattern", () => {
    const stderr = "5 failing tests";
    expect(extractSelfciDigest("", stderr)).toBe("5 failing tests");
  });

  it("extracts test suite failed", () => {
    const stderr = "Test suite failed to run";
    expect(extractSelfciDigest("", stderr)).toBe("Test suite failed to run");
  });

  it("returns undefined for unrecognized output", () => {
    expect(extractSelfciDigest("done", "ok")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildDigest
// ---------------------------------------------------------------------------

describe("buildDigest", () => {
  it("returns timeout message for timeout class", () => {
    const d = buildDigest({
      command: "npm test",
      failureClass: "timeout",
      exitCode: null,
      signal: "SIGTERM",
      stdout: "",
      stderr: "",
    });
    expect(d).toContain("Timed out");
    expect(d).toContain("npm test");
  });

  it("returns spawn error for spawn_error class", () => {
    const d = buildDigest({
      command: "missing-binary",
      failureClass: "spawn_error",
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "command not found: missing-binary",
    });
    expect(d).toContain("Spawn error");
    expect(d).toContain("command not found");
  });

  it("uses selfci digest for selfci commands", () => {
    const d = buildDigest({
      command: "npm test",
      failureClass: "exit_nonzero",
      exitCode: 1,
      signal: null,
      stdout: "Tests:  2 failed, 8 passed, 10 total",
      stderr: "",
    });
    expect(d).toBe("2 failed, 8 passed, 10 total");
  });

  it("falls back to first stderr line for non-selfci commands", () => {
    const d = buildDigest({
      command: "cargo build",
      failureClass: "exit_nonzero",
      exitCode: 1,
      signal: null,
      stdout: "",
      stderr: "error[E0308]: mismatched types\n  --> src/main.rs:5:5",
    });
    expect(d).toBe("error[E0308]: mismatched types");
  });

  it("falls back to exit code when no output", () => {
    const d = buildDigest({
      command: "cargo build",
      failureClass: "exit_nonzero",
      exitCode: 42,
      signal: null,
      stdout: "",
      stderr: "",
    });
    expect(d).toBe("Exit code 42");
  });

  it("falls back to signal when present", () => {
    const d = buildDigest({
      command: "cargo build",
      failureClass: "exit_nonzero",
      exitCode: null,
      signal: "SIGKILL",
      stdout: "",
      stderr: "",
    });
    expect(d).toBe("Killed by signal: SIGKILL");
  });
});
