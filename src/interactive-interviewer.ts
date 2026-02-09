/**
 * InteractiveInterviewer — stdin/stdout interviewer for CLI use.
 *
 * Presents questions to the user in the terminal and reads answers
 * from stdin. Supports multiple_choice, yes_no, confirmation, and
 * freeform question types.
 */

import { createInterface } from "node:readline";
import type { Interviewer, Question, Answer, Option } from "./pipeline/types.js";

/**
 * Read a single line from stdin. Returns the trimmed input.
 */
function prompt(message: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr, // prompts go to stderr so stdout stays clean for piping
  });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Interactive CLI interviewer.
 *
 * Renders questions to stderr and reads answers from stdin.
 * Works with any terminal that supports readline.
 */
export class InteractiveInterviewer implements Interviewer {
  async ask(question: Question): Promise<Answer> {
    console.error(); // blank line before question
    console.error(`  🙋 ${question.text}`);

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
    const defaultHint = question.default_answer?.value === "no" ? " [y/N]" : " [Y/n]";
    const input = await prompt(`     yes/no${defaultHint}: `);

    if (!input && question.default_answer) {
      return question.default_answer;
    }

    const lower = input.toLowerCase();
    if (lower === "y" || lower === "yes") {
      return { value: "yes" };
    }
    if (lower === "n" || lower === "no") {
      return { value: "no" };
    }

    // Default based on question default or "yes"
    return question.default_answer ?? { value: "yes" };
  }

  private async _askConfirmation(_question: Question): Promise<Answer> {
    const input = await prompt("     Press Enter to confirm, or type 'skip' to skip: ");
    if (input.toLowerCase() === "skip") {
      return { value: "skipped" };
    }
    return { value: "yes" };
  }

  private async _askMultipleChoice(question: Question): Promise<Answer> {
    if (question.options.length === 0) {
      return { value: "skipped" };
    }

    // Display options
    for (let i = 0; i < question.options.length; i++) {
      const opt = question.options[i];
      console.error(`     ${i + 1}) ${opt.label}`);
    }

    const defaultIdx = question.default_answer
      ? question.options.findIndex((o: Option) => o.key === question.default_answer!.value) + 1
      : 1;
    const hint = defaultIdx > 0 ? ` [${defaultIdx}]` : "";
    const input = await prompt(`     Choice${hint}: `);

    // Try numeric selection
    const num = parseInt(input, 10);
    if (num >= 1 && num <= question.options.length) {
      const selected = question.options[num - 1];
      return { value: selected.key, selected_option: selected };
    }

    // Try key match (case-insensitive)
    const byKey = question.options.find((o: Option) => o.key.toLowerCase() === input.toLowerCase());
    if (byKey) {
      return { value: byKey.key, selected_option: byKey };
    }

    // Try label match (case-insensitive, prefix)
    const byLabel = question.options.find((o: Option) =>
      o.label.toLowerCase().startsWith(input.toLowerCase()),
    );
    if (byLabel) {
      return { value: byLabel.key, selected_option: byLabel };
    }

    // Default
    if (!input && defaultIdx > 0) {
      const selected = question.options[defaultIdx - 1];
      return { value: selected.key, selected_option: selected };
    }

    // Fall back to first option
    const first = question.options[0];
    return { value: first.key, selected_option: first };
  }

  private async _askFreeform(_question: Question): Promise<Answer> {
    const input = await prompt("     > ");
    return { value: input, text: input };
  }
}
