/**
 * attractor-interviewer.ts — Interviewer implementation backed by pi's ctx.ui.
 *
 * Translates pipeline Question/Answer into pi UI dialogs (select, confirm,
 * input) so that human gates render natively inside the TUI.
 */

import type { Interviewer, Question, Answer, Option } from "../pipeline/types.js";

/**
 * Minimal UI surface needed by the interviewer.
 * Matches the subset of ExtensionUIContext we actually call.
 */
export interface InterviewerUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
}

/**
 * Pi TUI-backed interviewer.
 *
 * Maps each pipeline question type to a pi UI dialog:
 *  - yes_no       → ctx.ui.confirm
 *  - confirmation → ctx.ui.confirm
 *  - multiple_choice → ctx.ui.select
 *  - freeform     → ctx.ui.input
 */
export class PiInterviewer implements Interviewer {
  private _ui: InterviewerUI;

  constructor(ui: InterviewerUI) {
    this._ui = ui;
  }

  async ask(question: Question): Promise<Answer> {
    switch (question.type) {
      case "yes_no":
        return this._askYesNo(question);
      case "confirmation":
        return this._askConfirmation(question);
      case "multiple_choice":
        return this._askMultipleChoice(question);
      case "freeform":
        return this._askFreeform(question);
      default:
        return this._askFreeform(question);
    }
  }

  private async _askYesNo(question: Question): Promise<Answer> {
    const confirmed = await this._ui.confirm("Pipeline Gate", question.text);
    return { value: confirmed ? "yes" : "no" };
  }

  private async _askConfirmation(question: Question): Promise<Answer> {
    const confirmed = await this._ui.confirm("Confirm", question.text);
    return { value: confirmed ? "yes" : "skipped" };
  }

  private async _askMultipleChoice(question: Question): Promise<Answer> {
    if (question.options.length === 0) {
      return { value: "skipped" };
    }

    const labels = question.options.map((o: Option) => o.label);
    const selected = await this._ui.select(question.text, labels);

    if (selected == null) {
      // User cancelled — return default or first option
      if (question.default_answer) return question.default_answer;
      const first = question.options[0];
      return { value: first.key, selected_option: first };
    }

    const matched = question.options.find((o: Option) => o.label === selected);
    if (matched) {
      return { value: matched.key, selected_option: matched };
    }

    const first = question.options[0];
    return { value: first.key, selected_option: first };
  }

  private async _askFreeform(question: Question): Promise<Answer> {
    const text = await this._ui.input(question.text, "");
    return { value: text ?? "", text: text ?? "" };
  }
}
