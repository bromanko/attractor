---
title: Beautiful & Functional CLI UX
date: 2026-02-09
goal: Implement the beautiful-functional-cli-ux plan
status: approved
---

# Beautiful & Functional CLI UX

## Summary

Improve the Attractor CLI's terminal output to be visually clear, informative,
and pleasant to use. Address the five UX issues identified in TODO.md:

1. **Fix banner border alignment** — Box-drawing characters are misaligned.
2. **Label model as "Default model"** — Avoid confusion when stages override.
3. **Progress indication** — Spinner with elapsed timer for long-running stages.
4. **Show per-stage model** — Display non-default model next to stage name.
5. **Render markdown** — LLM responses rendered with ANSI formatting.

## Files Changed

- `src/cli-renderer.ts` — **New.** Extracted rendering module with:
  - `renderBanner()` — Correct box-drawing alignment, "Default model" label
  - `Spinner` class — Animated spinner with elapsed timer and per-stage model tag
  - `renderMarkdown()` — Markdown → ANSI via marked + marked-terminal
  - `renderSummary()` — Colorized completion summary
  - `renderResumeInfo()` — Resume checkpoint display
  - `formatDuration()` — Human-readable duration formatting
- `src/cli-renderer.test.ts` — **New.** 21 tests covering all renderer functions.
- `src/cli.ts` — **Modified.** Replaced inline banner/event formatting with
  calls to cli-renderer; wired Spinner for stage lifecycle events.
- `package.json` — **Modified.** Added `marked` and `marked-terminal` dependencies.

## Approach

- Extract all rendering logic into a dedicated `cli-renderer.ts` module for
  testability and separation of concerns.
- Use `marked` + `marked-terminal` for markdown rendering (already suggested
  in TODO.md). The terminal renderer provides ANSI formatting for headings,
  code blocks, lists, emphasis, and links.
- The `Spinner` uses ANSI cursor control (`\r\x1b[K`) for in-place updates
  at 80ms intervals, showing elapsed time and an optional model tag.
- Banner uses plain-text padding before applying box-drawing, ensuring all
  rows have identical visible width.
- Per-stage model is resolved by comparing the node's `llm_model` attribute
  against the default model passed on the command line.

## Test Cases

1. Banner renders all fields and labels model as "Default model"
2. Banner box-drawing lines have consistent visible width
3. Banner truncates long goals without breaking alignment
4. Markdown rendering: headings, code blocks, lists, plain text
5. Duration formatting: seconds, minutes, hours, zero
6. Summary renders success/failure with elapsed time
7. Resume info displays checkpoint details
8. Spinner starts/stops with success/failure status
9. Spinner displays model tag when provided, omits when not
10. Spinner shows elapsed time

## Decision Log

- Chose to drop ANSI color codes from the banner content rows to guarantee
  width consistency. The banner is clear and readable without inline color;
  the spinner and summary use color where it adds value.
- Used `marked-terminal` named export `markedTerminal()` rather than default
  export, matching the library's ESM API.
