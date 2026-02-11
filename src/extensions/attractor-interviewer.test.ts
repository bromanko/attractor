import { describe, it, expect, vi } from "vitest";
import type { Question, Option } from "../pipeline/types.js";
import { PiInterviewer, type InterviewerUI } from "./attractor-interviewer.js";

function mockUI(overrides: Partial<InterviewerUI> = {}): InterviewerUI {
  return {
    select: vi.fn(async () => undefined),
    confirm: vi.fn(async () => true),
    input: vi.fn(async () => ""),
    ...overrides,
  };
}

describe("PiInterviewer", () => {
  describe("yes_no", () => {
    it("returns yes when confirmed", async () => {
      const ui = mockUI({ confirm: vi.fn(async () => true) });
      const interviewer = new PiInterviewer(ui);
      const q: Question = {
        text: "Continue?",
        type: "yes_no",
        options: [],
        stage: "test",
      };
      const answer = await interviewer.ask(q);
      expect(answer.value).toBe("yes");
      expect(ui.confirm).toHaveBeenCalledWith("Pipeline Gate", "Continue?");
    });

    it("returns no when declined", async () => {
      const ui = mockUI({ confirm: vi.fn(async () => false) });
      const interviewer = new PiInterviewer(ui);
      const q: Question = {
        text: "Continue?",
        type: "yes_no",
        options: [],
        stage: "test",
      };
      const answer = await interviewer.ask(q);
      expect(answer.value).toBe("no");
    });
  });

  describe("confirmation", () => {
    it("returns yes when confirmed", async () => {
      const ui = mockUI({ confirm: vi.fn(async () => true) });
      const interviewer = new PiInterviewer(ui);
      const q: Question = {
        text: "Proceed?",
        type: "confirmation",
        options: [],
        stage: "test",
      };
      const answer = await interviewer.ask(q);
      expect(answer.value).toBe("yes");
    });

    it("returns skipped when declined", async () => {
      const ui = mockUI({ confirm: vi.fn(async () => false) });
      const interviewer = new PiInterviewer(ui);
      const q: Question = {
        text: "Proceed?",
        type: "confirmation",
        options: [],
        stage: "test",
      };
      const answer = await interviewer.ask(q);
      expect(answer.value).toBe("skipped");
    });
  });

  describe("multiple_choice", () => {
    const options: Option[] = [
      { key: "A", label: "Approve" },
      { key: "R", label: "Revise" },
    ];

    it("returns selected option", async () => {
      const ui = mockUI({ select: vi.fn(async () => "Revise") });
      const interviewer = new PiInterviewer(ui);
      const q: Question = {
        text: "Choose:",
        type: "multiple_choice",
        options,
        stage: "test",
      };
      const answer = await interviewer.ask(q);
      expect(answer.value).toBe("R");
      expect(answer.selected_option).toEqual({ key: "R", label: "Revise" });
    });

    it("returns first option when cancelled", async () => {
      const ui = mockUI({ select: vi.fn(async () => undefined) });
      const interviewer = new PiInterviewer(ui);
      const q: Question = {
        text: "Choose:",
        type: "multiple_choice",
        options,
        stage: "test",
      };
      const answer = await interviewer.ask(q);
      expect(answer.value).toBe("A");
    });

    it("returns default answer when cancelled and default exists", async () => {
      const ui = mockUI({ select: vi.fn(async () => undefined) });
      const interviewer = new PiInterviewer(ui);
      const q: Question = {
        text: "Choose:",
        type: "multiple_choice",
        options,
        stage: "test",
        default_answer: { value: "R", selected_option: options[1] },
      };
      const answer = await interviewer.ask(q);
      expect(answer.value).toBe("R");
    });

    it("returns skipped for empty options", async () => {
      const ui = mockUI();
      const interviewer = new PiInterviewer(ui);
      const q: Question = {
        text: "Choose:",
        type: "multiple_choice",
        options: [],
        stage: "test",
      };
      const answer = await interviewer.ask(q);
      expect(answer.value).toBe("skipped");
    });
  });

  describe("freeform", () => {
    it("returns text input", async () => {
      const ui = mockUI({ input: vi.fn(async () => "my feedback") });
      const interviewer = new PiInterviewer(ui);
      const q: Question = {
        text: "Feedback?",
        type: "freeform",
        options: [],
        stage: "test",
      };
      const answer = await interviewer.ask(q);
      expect(answer.value).toBe("my feedback");
      expect(answer.text).toBe("my feedback");
    });

    it("returns empty string when cancelled", async () => {
      const ui = mockUI({ input: vi.fn(async () => undefined) });
      const interviewer = new PiInterviewer(ui);
      const q: Question = {
        text: "Feedback?",
        type: "freeform",
        options: [],
        stage: "test",
      };
      const answer = await interviewer.ask(q);
      expect(answer.value).toBe("");
    });
  });

  describe("unknown type", () => {
    it("falls back to freeform", async () => {
      const ui = mockUI({ input: vi.fn(async () => "fallback") });
      const interviewer = new PiInterviewer(ui);
      const q: Question = {
        text: "Whatever?",
        type: "unknown_type" as any,
        options: [],
        stage: "test",
      };
      const answer = await interviewer.ask(q);
      expect(answer.value).toBe("fallback");
    });
  });
});
