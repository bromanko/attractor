---
title: Plan: Workflow usage/cost metrics in CLI output
date: 2026-02-10
goal: Let's come up with a plan for the TODO.md item Workflow usage/cost metrics in CLI output
status: approved
---

## Summary

Add **always-on** usage/cost telemetry to CLI workflow runs with:

- **Live, in-flight updates** while stages run (streaming token/cost progress)
- **Always-present final usage footer** at completion
- **Per-stage completed-attempt breakdown** plus run totals

The backend already captures usage (`${nodeId}.usage.*`), but the CLI does not currently surface it. This plan wires usage through backend events, engine aggregation, and CLI rendering.

## Key Decisions (Approved)

1. Final footer is **mandatory** (not optional, no feature flag).
2. Run totals include **all attempts** (retries count toward spend/tokens).
3. For resumed runs, show usage for the **current invocation only**.
4. Live updates are **always on** (no CLI flag).
5. Final table shows **all completed attempts/stages in scope**.
6. Missing cost is rendered as **`0`** (not `n/a`).
7. Cost formatting uses **adaptive precision**.
8. Implement **true in-flight token streaming** (not stage-boundary-only snapshots).

## Files to Change

1. `src/pipeline/types.ts`
   - Add explicit usage types:
     - `UsageMetrics`
     - `StageAttemptUsage`
     - `RunUsageSummary`
     - usage event payload types for streaming updates.

2. `src/pi-backend.ts`
   - Emit usage snapshots/deltas from streaming callbacks (`onStageEvent`) so in-flight usage can be forwarded.
   - Preserve monotonic semantics to avoid overcounting when providers emit snapshot-style updates.

3. `src/pi-backend.test.ts`
   - Add tests for streaming usage emission and monotonic update behavior.

4. `src/pipeline/engine.ts`
   - Track usage per attempt and aggregate run totals across all attempts.
   - Keep clear boundaries so resumed invocations only account for current run.
   - Emit usage updates during execution and completion.
   - Attach `usageSummary?: RunUsageSummary` to `PipelineResult` (optional for compatibility).

5. `src/pipeline/engine.test.ts`
   - Add coverage for:
     - retry/all-attempt aggregation
     - resumed-run invocation scoping
     - partial/missing usage values
     - failed/cancelled runs still returning usage summary.

6. `src/cli.ts`
   - Maintain running usage state from streamed usage events.
   - Continuously render live usage (always on), with throttling/coalescing to avoid flicker/churn.
   - Pass final usage summary to renderer unconditionally.

7. `src/cli.test.ts`
   - Verify CLI forwards usage summaries and handles live streaming updates without noisy output regressions.

8. `src/cli-renderer.ts`
   - Extend `renderSummary()` to always print usage section:
     - totals row
     - completed attempt/stage breakdown
     - stable handling for missing metrics (`n/a` except cost=`0`)
     - adaptive cost precision formatting.

9. `src/cli-renderer.test.ts`
   - Add tests for full, partial, and absent usage data, plus formatting and alignment.

## Implementation Approach

### 1) Define canonical usage model

Use canonical fields:

- `input_tokens`
- `output_tokens`
- `cache_read_tokens`
- `cache_write_tokens`
- `total_tokens`
- `cost`

Parse from `${nodeId}.usage.<field>` and from streaming stage events.

### 2) Support true in-flight telemetry

- Extend backend event handling to forward usage during stage execution.
- Treat incoming usage as snapshot-like unless explicitly marked delta.
- Maintain per-attempt last-seen snapshot and compute monotonic increments before applying to totals.

### 3) Aggregate in engine

- Store usage by `(stageId, attemptNumber)`.
- Aggregate totals across all attempts for the current invocation.
- Keep summary generation deterministic across success/failure/cancel/retry paths.
- Surface final `RunUsageSummary` via `PipelineResult`.

### 4) Render live CLI usage

- Always show running usage during execution.
- Coalesce repaints to reduce high-frequency churn.
- Ensure rendering degrades cleanly when some metrics are missing.

### 5) Render final summary footer

- Always print a usage section.
- Include totals and per-stage/attempt breakdown for completed attempts in scope.
- Print missing token fields as `n/a`; print missing/unknown cost as `0`.
- Use adaptive cost precision for readability at small values.

## Edge Cases and Semantics

- **Retries:** totals include all attempts.
- **Resume:** only usage produced in the current resumed invocation is counted.
- **Malformed values:** ignore invalid/non-numeric values safely.
- **Stages without usage:** render stable `n/a` fields (cost remains `0`).
- **Failure/cancellation:** still emit and render final usage summary from available data.
- **Compatibility:** new result/event usage fields remain optional for existing callers.

## Test Plan

1. Happy-path workflow with multiple stages and full usage fields.
2. Partial usage (missing cache/cost/totals) and graceful rendering.
3. No usage available at all: mandatory usage footer still present.
4. Retry scenario: totals include all attempts.
5. Resume scenario: totals scoped to current invocation only.
6. Streaming updates: monotonic accumulation without double counting.
7. Failed/cancelled runs: usage summary still returned/rendered.
8. Renderer formatting: adaptive cost precision, table stability, long-stage handling.

## Decision Log

- **Initial draft** proposed optional live/footer behavior and left several semantics open (`all attempts vs final`, resume scope, live flag, cost display, stage scope, and streaming depth).
- **Review feedback** requested explicit behavior: mandatory footer, all-attempt totals, current-invocation resume semantics, always-on live updates, completed attempts in scope, cost default `0`, adaptive precision, and true in-flight streaming.
- **Final approved revision** incorporates all review decisions and expands test coverage in backend, engine, CLI, and renderer layers.
