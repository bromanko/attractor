import { describe, it, expect, vi } from "vitest";
import type { Question, Option } from "./pipeline/types.js";

// Mock readline to avoid actual stdin interaction
vi.mock("node:readline", () => ({
  createInterface: () => ({
    question: (_msg: string, cb: (answer: string) => void) => cb(""),
    close: () => {},
  }),
}));

import { InteractiveInterviewer } from "./interactive-interviewer.js";

describe("InteractiveInterviewer", () => {
  const interviewer = new InteractiveInterviewer();

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
});
