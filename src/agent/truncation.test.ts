import { describe, it, expect } from "vitest";
import { truncateChars, truncateLines, truncateToolOutput } from "./truncation.js";
import { DEFAULT_SESSION_CONFIG } from "./types.js";

describe("Truncation", () => {
  describe("truncateChars", () => {
    it("returns short output unchanged", () => {
      expect(truncateChars("short", 100, "head_tail")).toBe("short");
    });

    it("head_tail mode keeps beginning and end", () => {
      const input = "A".repeat(100);
      const result = truncateChars(input, 50, "head_tail");
      expect(result).toContain("WARNING");
      expect(result).toContain("characters were removed");
      // Should start with As and end with As
      expect(result.startsWith("A")).toBe(true);
      expect(result.endsWith("A")).toBe(true);
    });

    it("tail mode keeps the end", () => {
      const input = "B".repeat(100);
      const result = truncateChars(input, 50, "tail");
      expect(result).toContain("WARNING");
      expect(result.endsWith("B")).toBe(true);
    });
  });

  describe("truncateLines", () => {
    it("returns short output unchanged", () => {
      expect(truncateLines("line1\nline2", 10)).toBe("line1\nline2");
    });

    it("splits head and tail", () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
      const result = truncateLines(lines, 10);
      expect(result).toContain("lines omitted");
      expect(result).toContain("line 0");
      expect(result).toContain("line 99");
    });
  });

  describe("truncateToolOutput", () => {
    it("applies char limit then line limit for shell", () => {
      // Create output with many short lines under char limit
      const lines = Array.from({ length: 500 }, (_, i) => `output ${i}`).join("\n");
      const result = truncateToolOutput(lines, "shell", DEFAULT_SESSION_CONFIG);
      // Should have line truncation
      const lineCount = result.split("\n").length;
      expect(lineCount).toBeLessThan(500);
    });

    it("char truncation runs first for pathological input", () => {
      // 2 lines but massive: char truncation must catch this
      const input = "x".repeat(100_000) + "\n" + "y".repeat(100_000);
      const result = truncateToolOutput(input, "read_file", DEFAULT_SESSION_CONFIG);
      expect(result.length).toBeLessThan(100_000);
      expect(result).toContain("WARNING");
    });
  });
});
