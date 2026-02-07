/**
 * Built-in Interviewer implementations — Section 6.4 of the Attractor Spec.
 */

import type { Interviewer, Question, Answer } from "./types.js";

/**
 * Always selects YES or the first option (Section 6.4).
 * For automated testing and CI/CD.
 */
export class AutoApproveInterviewer implements Interviewer {
  async ask(question: Question): Promise<Answer> {
    if (question.type === "yes_no" || question.type === "confirmation") {
      return { value: "yes" };
    }
    if (question.type === "multiple_choice" && question.options.length > 0) {
      return {
        value: question.options[0].key,
        selected_option: question.options[0],
      };
    }
    return { value: "auto-approved", text: "auto-approved" };
  }
}

/**
 * Reads from a pre-filled answer queue (Section 6.4).
 * For deterministic testing and replay.
 */
export class QueueInterviewer implements Interviewer {
  private _answers: Answer[];

  constructor(answers: Answer[]) {
    this._answers = [...answers];
  }

  async ask(_question: Question): Promise<Answer> {
    if (this._answers.length > 0) {
      return this._answers.shift()!;
    }
    return { value: "skipped" };
  }
}

/**
 * Delegates to a callback function (Section 6.4).
 */
export class CallbackInterviewer implements Interviewer {
  private _callback: (question: Question) => Promise<Answer>;

  constructor(callback: (question: Question) => Promise<Answer>) {
    this._callback = callback;
  }

  async ask(question: Question): Promise<Answer> {
    return this._callback(question);
  }
}

/**
 * Records all Q&A pairs wrapping another interviewer.
 */
export class RecordingInterviewer implements Interviewer {
  private _inner: Interviewer;
  readonly recordings: Array<{ question: Question; answer: Answer }> = [];

  constructor(inner: Interviewer) {
    this._inner = inner;
  }

  async ask(question: Question): Promise<Answer> {
    const answer = await this._inner.ask(question);
    this.recordings.push({ question, answer });
    return answer;
  }
}
