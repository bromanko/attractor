import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Question, Option } from "./pipeline/types.js";

// Mock readline to avoid actual stdin interaction
vi.mock("node:readline", () => ({
  createInterface: () => ({
    question: (_msg: string, cb: (answer: string) => void) => cb(""),
    close: () => {},
  }),
}));

vi.mock("./cli-renderer.js", () => ({
  renderMarkdown: vi.fn((text: string) => `[[rendered:${text}]]`),
}));

import { InteractiveInterviewer } from "./interactive-interviewer.js";
import { renderMarkdown } from "./cli-renderer.js";

describe("InteractiveInterviewer", () => {
  const interviewer = new InteractiveInterviewer();
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.clearAllMocks();
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("handles yes_no question with default", async () => {
    const question: Question = {
      text: "Continue?",
      type: "yes_no",
      options: [],
      stage: "test",
      default_answer: { value: "yes" },
    };
    const answer = await interviewer.ask(question);
    expect(answer.value).toBe("yes");
  });

  it("handles confirmation question with empty input", async () => {
    const question: Question = {
      text: "Confirm?",
      type: "confirmation",
      options: [],
      stage: "test",
    };
    const answer = await interviewer.ask(question);
    expect(answer.value).toBe("yes");
  });

  it("handles multiple_choice with empty input (selects default)", async () => {
    const options: Option[] = [
      { key: "A", label: "Approve" },
      { key: "R", label: "Revise" },
    ];
    const question: Question = {
      text: "Choose:",
      type: "multiple_choice",
      options,
      stage: "test",
    };
    const answer = await interviewer.ask(question);
    // Empty input with default index 1 → first option
    expect(answer.value).toBe("A");
  });

  it("handles freeform question", async () => {
    const question: Question = {
      text: "Feedback?",
      type: "freeform",
      options: [],
      stage: "test",
    };
    const answer = await interviewer.ask(question);
    expect(answer.value).toBe("");
    expect(answer.text).toBe("");
  });

  it("handles multiple_choice with no options", async () => {
    const question: Question = {
      text: "Choose:",
      type: "multiple_choice",
      options: [],
      stage: "test",
    };
    const answer = await interviewer.ask(question);
    expect(answer.value).toBe("skipped");
  });

  it("prints rendered details_markdown between blank lines", async () => {
    const question: Question = {
      text: "Review this plan",
      details_markdown: "# Header\n\nBody",
      type: "yes_no",
      options: [],
      stage: "test",
      default_answer: { value: "yes" },
    };

    await interviewer.ask(question);

    expect(renderMarkdown).toHaveBeenCalledWith("# Header\n\nBody");
    expect(errorSpy.mock.calls.map((args) => args[0])).toEqual([
      undefined,
      "  🙋 Review this plan",
      undefined,
      "[[rendered:# Header\n\nBody]]",
      undefined,
    ]);
  });

  it("does not print markdown block when details_markdown is absent", async () => {
    const question: Question = {
      text: "Review this plan",
      type: "yes_no",
      options: [],
      stage: "test",
      default_answer: { value: "yes" },
    };

    await interviewer.ask(question);

    expect(renderMarkdown).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.map((args) => args[0])).toEqual([
      undefined,
      "  🙋 Review this plan",
    ]);
  });
});
