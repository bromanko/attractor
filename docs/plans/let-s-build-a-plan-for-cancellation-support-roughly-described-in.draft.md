1. ## Summary

Implement first-class pipeline cancellation with a dedicated cancel path end-to-end:
- CLI creates an `AbortController` and aborts on `SIGINT`/`SIGTERM`.
- Pipeline engine accepts `abortSignal` and exposes a dedicated cancellation path.
- Codergen backends accept run options with `signal` and cancel in-flight work cooperatively.
- Emit a new `pipeline_cancelled` event (not `pipeline_failed`).
- On cancellation, keep workspace and persist a final checkpoint for resume.

---

2. ## Files to change

1. **`src/pipeline/types.ts`**
   - Extend backend contract to accept run options:
     - `run(..., options?: { signal?: AbortSignal })`
   - Add dedicated cancellation API/result types:
     - e.g. `cancelled` outcome/reason alongside existing success/failure.
   - Add new pipeline event: `pipeline_cancelled`.

2. **`src/pipeline/engine.ts`**
   - Add `abortSignal?: AbortSignal` to `PipelineConfig`.
   - Add explicit cancellation checks:
     - before stage execution,
     - after stage completion and before scheduling next stage,
     - inside retry/backoff wait.
   - Hard guard: once aborted, no more retries/stages are scheduled.
   - Emit `pipeline_cancelled` and return cancelled result.
   - Persist checkpoint on cancel and skip emergency workspace cleanup.

3. **`src/pipeline/handlers.ts`**
   - Thread `abortSignal` through `HandlerRegistry` into `CodergenHandler`.
   - Pass `{ signal }` into backend `run()`.

4. **`src/pi-backend.ts`**
   - Update `run()` signature to accept run options with `signal`.
   - Implement cooperative cancellation:
     - immediate short-circuit if pre-aborted,
     - attach abort listener for in-flight prompt,
     - invoke dedicated session cancel API if available, otherwise fallback to `dispose()`.
   - Return deterministic cancelled outcome (not generic failure).

5. **`src/pipeline/llm-backend.ts`**
   - Keep interface compatibility by accepting optional run options.
   - Ignore or forward `signal` depending on backend capability.

6. **`src/cli.ts`**
   - Create one `AbortController` per run and pass signal into pipeline config.
   - Register one-shot `SIGINT`/`SIGTERM` handlers that call `abort()`.
   - Remove handlers in `finally` to avoid leaks across runs/tests.
   - Show clear cancellation messaging and ensure spinner cleanup.

7. **Tests**
   - **`src/pi-backend.test.ts`**: pre-aborted, mid-flight abort, cancellation API vs dispose fallback, no double-dispose.
   - **`src/pipeline/engine.test.ts`**: cancel before start, during stage, during retry backoff; verify no further retries/stages and `pipeline_cancelled` emission.
   - **`src/cli.test.ts`**: signal triggers abort, handlers are cleaned up, spinner/output reflect cancellation.

---

3. ## Implementation approach

1. **Define cancellation semantics first**
   - Add explicit cancelled result + `pipeline_cancelled` event in shared pipeline types.
   - Treat cancellation as distinct from failure in engine + CLI output.

2. **Thread signal through execution stack**
   - CLI `AbortController` → `runPipeline({ abortSignal })` → `HandlerRegistry` → backend `run(..., { signal })`.

3. **Implement backend cooperative cancel**
   - Pre-abort short-circuit.
   - Mid-flight abort listener calls cancel/dispose and resolves with cancelled outcome.

4. **Make retries/backoff abort-aware**
   - Replace plain sleep with abortable delay.
   - Bail immediately when aborted; never continue retry loop.

5. **Cancellation persistence policy**
   - Write a checkpoint on cancel for resume.
   - Preserve workspace (no emergency cleanup on cancelled outcome).

---

4. ## Edge cases to handle

1. Signal is already aborted before pipeline starts.
2. Abort fires while `session.prompt()` is in flight.
3. Abort arrives during retry sleep/backoff.
4. Abort races with normal completion (avoid double-finalization/events).
5. Multiple signals (Ctrl-C twice) should not duplicate cancellation handling.
6. CLI invoked repeatedly in-process should not accumulate signal handlers.

---

5. ## Acceptance checks

1. Ctrl-C during codergen stage exits quickly with cancelled result.
2. Pipeline emits `pipeline_cancelled` (not `pipeline_failed`) and CLI reports cancellation clearly.
3. No additional stages/retries run after abort.
4. Final checkpoint exists after cancellation.
5. Workspace is preserved on cancellation.
6. Existing non-cancellation success/failure flows remain unchanged.
