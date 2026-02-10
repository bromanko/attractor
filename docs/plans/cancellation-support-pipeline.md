---
title: Pipeline Cancellation Support
date: 2026-02-10
goal: Let's build a plan for cancellation support roughly described in TODO.md
status: approved
---

# Pipeline Cancellation Support

## Summary

Implement first-class, cooperative cancellation end-to-end for long-running pipeline execution:

- CLI creates an `AbortController` per run and aborts on `SIGINT`/`SIGTERM`.
- Pipeline engine accepts `abortSignal` and enforces a dedicated cancellation path.
- Codergen backend calls accept run options with `signal` and cancel in-flight work.
- Pipeline emits `pipeline_cancelled` (not `pipeline_failed`) when aborted.
- On cancellation, keep the workspace and persist a checkpoint to support resume.

## Files to Change

1. **`src/pipeline/types.ts`**
   - Extend backend contract to support optional run options:
     - `run(..., options?: { signal?: AbortSignal })`
   - Add explicit cancelled result/reason types.
   - Add new pipeline event: `pipeline_cancelled`.
   - Update all affected switch/case handling sites to cover new cancellation types.

2. **`src/pipeline/engine.ts`**
   - Add `abortSignal?: AbortSignal` to `PipelineConfig`.
   - Thread signal into `HandlerRegistry`.
   - Add cancellation checks:
     - before stage execution,
     - after stage completion (before scheduling next stage),
     - during retry/backoff wait.
   - Hard guard: once aborted, do not schedule further retries/stages.
   - Emit `pipeline_cancelled` and return cancelled result.
   - Save checkpoint on cancellation.
   - Skip emergency workspace cleanup on cancellation.

3. **`src/pipeline/handlers.ts`**
   - Add signal support to `HandlerRegistry` construction/options.
   - Thread signal into `CodergenHandler`.
   - Pass `{ signal }` to backend `run()`.

4. **`src/pi-backend.ts`**
   - Update `run()` signature to accept optional run options with `signal`.
   - Implement cooperative cancellation behavior:
     - immediate short-circuit if already aborted,
     - attach abort listener for in-flight prompt/session,
     - call dedicated session cancel API when available,
     - fallback to `dispose()` if cancel API is unavailable.
   - Normalize cancellation outcomes to deterministic cancelled result semantics.
   - Ensure listener cleanup and idempotent cancellation/disposal behavior.

5. **`src/pipeline/llm-backend.ts`**
   - Accept optional run options for interface compatibility.
   - Ignore or forward `signal` based on backend capability.

6. **`src/cli.ts`**
   - Create one `AbortController` per run.
   - Register one-shot `SIGINT`/`SIGTERM` handlers that abort controller signal.
   - Pass `abortSignal` into pipeline invocation.
   - Ensure spinner/output teardown is clean on cancellation.
   - Remove signal handlers in `finally` to prevent leaks across runs/tests.
   - Display clear cancellation messaging to users.

7. **Tests**
   - **`src/pi-backend.test.ts`**
     - pre-aborted signal returns cancelled outcome,
     - mid-flight abort triggers cancel/dispose path,
     - no duplicate disposal,
     - no uncaught rejections,
     - listener cleanup is verified.
   - **`src/pipeline/engine.test.ts`**
     - abort before first stage exits immediately as cancelled,
     - abort during active stage prevents downstream execution,
     - abort during retry backoff exits without waiting full delay,
     - cancellation emits `pipeline_cancelled`,
     - checkpoint persisted on cancel,
     - workspace is not emergency-cleaned on cancel.
   - **CLI/integration tests (`src/cli.test.ts` and/or end-to-end test)**
     - signal-triggered abort propagates into engine/backend,
     - spinner is stopped/cleared,
     - cancellation messaging is shown,
     - signal handlers are de-registered after run,
     - includes at least one end-to-end cancellation flow validation.

## Approach

1. **Introduce run options without breaking callers**
   - Add optional `options` parameter in backend interfaces and implementations.
   - Keep existing non-cancellation behavior intact.

2. **Thread cancellation top-down**
   - CLI owns abort controller.
   - Engine receives `abortSignal`.
   - Handler registry and codergen handler pass signal to backend.

3. **Make retries/backoff abort-aware**
   - Replace plain sleep/backoff waits with abort-aware waiting.
   - Stop immediately if signal aborts during delay.

4. **Define explicit cancellation semantics**
   - Cancellation is a first-class path with `pipeline_cancelled` event and cancelled result type.
   - Cancellation is distinct from generic failure.

5. **Operational behavior on cancellation**
   - Persist checkpoint on cancel for resumability.
   - Keep workspace for inspection/resume workflows.

6. **Reliability details**
   - Ensure cancellation path is idempotent.
   - Ensure event emission, resource disposal, and listener cleanup occur exactly once.

## Edge Cases

1. Signal already aborted before run starts.
2. Abort during active `session.prompt()`.
3. Abort during retry/backoff sleep.
4. Abort races with normal completion.
5. Multiple abort signals/events (idempotent handling).
6. Handler/listener lifecycle across repeated CLI runs and tests.

## Decision Log

- **Revised during review:** moved from ambiguous cancellation handling to a dedicated cancellation API/path.
- **Revised during review:** adopted explicit `pipeline_cancelled` event instead of overloading `pipeline_failed`.
- **Revised during review:** cancellation now keeps workspace (no emergency cleanup), aligned with resume workflow.
- **Revised during review:** added checkpoint persistence on cancellation.
- **Integrated critique feedback:**
  - enumerate type-surface impact (`types.ts` changes must be handled in all switch/case consumers),
  - require explicit listener lifecycle cleanup in CLI/backend,
  - require deterministic and idempotent backend cancel/dispose behavior,
  - require at least one end-to-end cancellation test beyond unit tests.
