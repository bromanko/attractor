---
title: Stage Orchestration Reliability Hardening
slug: stage-orchestration-reliability-hardening
status: approved
date: 2026-02-15
owners:
  - attractor
summary: >-
  Eliminate flaky stage outcomes in the Implement Plan workflow by hardening
  Pi-native stage completion semantics, status-marker handling, and workspace
  cleanup reporting.
---

## 1) Summary

Fix the reliability issues observed in the full run log for `implement-plan`:

1. Tool calls skipped with `Skipped due to queued user message.`
2. False `Missing [STATUS: ...] marker` failures in review stages.
3. Multiple gate→fix loops caused by protocol/formatting failures rather than code failures.
4. `ws_cleanup` reported success while workspace directory still existed with modified files.

This plan focuses on **deterministic stage completion**, **recoverable protocol failures**, and **truthful cleanup semantics**.

---

## 2) Incident context (from the exact session log)

Log analyzed:
- `~/.pi/agent/sessions/--home-bromanko.linux-Code-attractor--/2026-02-15T19-17-14-968Z_dab54f3f-c38f-4e76-b726-c9a684b8a203.jsonl`
- 387 lines total.

Observed anomalies (line numbers in that file):

- **Skipped tool results (6x):** lines `14, 18, 19, 31, 35, 36`
  - Message text: `Skipped due to queued user message.`
- **Missing status-marker stage failures (3x):**
  - `review_code` fail at line `152`
  - `review_security` fail at line `256`
  - `review_perf` fail at line `307`
- **Gate forwarded fail 3 times before eventual success:**
  - fail forwards: lines `158, 262, 311`
  - success forward: line `360`
- **Provider capability error:** line `365`
  - `This model does not support assistant message prefill. The conversation must end with a user message.`
- **Cleanup mismatch:** `ws_cleanup` stage reports success at line `376`, but post-run user check showed workspace dir still present and dirty.

---

## 3) Goals and non-goals

### Goals

- No skipped tool results for normal stage execution.
- No false negative status-marker failures when assistant output includes marker.
- Protocol/transient review failures should retry in place before entering `fix` loop.
- Workspace cleanup status must accurately reflect what happened (forgotten vs removed).

### Non-goals

- Reworking overall workflow architecture.
- Adding caching for workflow discovery.
- Changing review severity policy/content.
- Implementing provider-specific prefill compatibility handling in this phase.

---

## 4) Files to change

### Core reliability
- `src/pi-native-backend.ts`
- `src/pi-native-backend.test.ts`
- `src/pi-backend.ts` (only if marker parser fallback/hardening is needed)

### Workflow behavior
- `.attractor/workflows/implement-plan.awf.kdl`

### Cleanup semantics
- `src/pipeline/workspace.ts`
- `src/pipeline/workspace.test.ts`

### Optional docs
- `README.md` (workspace cleanup semantics note)
- `docs/attractor-extension.md` (if user-facing behavior changes)

---

## 5) Approach

### A) Harden Pi-native stage completion + skip detection

In `PiNativeBackend.run`:

1. Add explicit per-run completion latch:
   - Do not parse outcome until both conditions are met:
     - `ctx.waitForIdle()` completes, and
     - `agent_end` event for active run token is captured.
2. Add bounded wait for `agent_end` with strict abort/timeout semantics:
   - timeout returns explicit protocol failure (not hang),
   - cancellation clears run token/handlers deterministically.
3. Detect skip failures using structured tool-result metadata first (when available), with text-match fallback for `Skipped due to queued user message.`.
4. Retry dispatch once (max once) only when all of the following are true:
   - failure class is transient protocol skip,
   - no mutating tool completed successfully in the failed attempt.
5. If mutating tool side effects may have occurred, do **not** auto-retry; fail with explicit reason (e.g. `tool_result_skipped_after_side_effect`) so human/fix flow can resolve safely.

Expected result: stage does not complete against empty/stale response, does not silently accept skipped-tool runs, and avoids duplicate side effects from unsafe retries.

### B) Harden status marker reliability

1. Keep marker requirement for `auto_status=true`, but ensure parser reads the **final assistant text for the completed run** (not stale/empty payload).
2. Parse the **last** `[STATUS: ...]` marker in response text (more robust when model includes examples earlier in output).
3. Add explicit failure reason key for protocol failures (e.g. `missing_status_marker`, `tool_result_skipped`) so downstream routing is diagnosable.

### C) Reduce unnecessary gate→fix loops for review protocol failures

Update `.attractor/workflows/implement-plan.awf.kdl` + backend failure mapping:

1. Add local retry capacity to review stages (`review_code`, `review_security`, `review_perf`, `review_tests`) for transient protocol recovery.
2. Ensure only protocol/transient classes trigger in-place retry (e.g. `missing_status_marker`, `tool_result_skipped`, provider-compat retry).
   - Semantic review outcomes (`[STATUS: fail]` with real findings) should remain `fail` and proceed to gate/fix as before.
3. Keep existing `fix` path for actual review/code failures after retry exhaustion.

This preserves workflow intent while removing churn from formatting/race glitches without masking real review failures.

### D) Make workspace cleanup truthful and observable

In `WorkspaceCleanupHandler`:

1. Stop silently swallowing rm failures as unconditional success.
2. Distinguish outcomes:
   - forgot workspace + removed dir => `success`
   - forgot workspace but dir removal failed/skipped => `partial_success` with clear note and context flag
3. Persist cleanup details in `cleanup.json`:
   - `forgotWorkspace: boolean`
   - `removedDirectory: boolean`
   - `cleanupWarnings: string[]`
4. Ensure `partial_success` is surfaced in user-visible summaries (CLI + extension panel/notifications), including the residual path and warning text.

This directly addresses user confusion where cleanup says success but workspace path still exists.

---

## 6) Edge cases to cover

- `agent_end` arrives late relative to idle signal.
- Stage receives assistant text but parser sees empty text due race.
- Marker appears multiple times in response.
- Marker missing on first try but present on retry.
- Tool skip transient repeats after one retry.
- Tool skip transient detected after mutating tool side effects (must not auto-retry).
- Structured skip metadata unavailable; text fallback still classifies correctly.
- Workspace forget succeeds but directory removal fails (permissions/CWD/EBUSY).
- Cleanup called with missing workspace path.
- Cleanup returns `partial_success` and is visibly rendered to users (not hidden as generic success).

---

## 7) Test plan

### Pi-native backend tests (`src/pi-native-backend.test.ts`)

1. Wait-for-completion test: backend does not parse outcome until `agent_end` is captured.
2. Abort/timeout test: missing `agent_end` times out with explicit protocol failure and clears run state.
3. Skip detection test (structured + fallback): skip classification works from metadata and from text fallback.
4. Retry safety test: transient skip retries once only when no mutating tool succeeded.
5. No-unsafe-retry test: if mutating tool side effects are detected, backend returns explicit failure without auto-retry.
6. Status-marker race test: assistant message has marker, backend returns success (no false missing-marker fail).

### Parser tests (`src/pi-backend` / relevant parser tests)

1. Last-marker-wins parsing.
2. Missing marker with `auto_status=true` still fails deterministically.

### Workflow behavior tests

1. Integration test where review stage first fails with missing marker then succeeds on retry, without entering `fix`.
2. Integration test where review stage returns semantic `[STATUS: fail]` and does **not** consume protocol retry budget; it should proceed to gate/fix.

### Workspace cleanup tests (`src/pipeline/workspace.test.ts`)

1. rm failure returns `partial_success` and records warning.
2. cleanup.json includes forgot/removed flags accurately.
3. success path remains unchanged when removal succeeds.
4. CLI/extension-facing summary rendering includes partial cleanup warning details.

### End-to-end validation

- `selfci check` must pass.
- Re-run implement-plan and verify:
  - no unhandled skip-protocol failures (and no repeated gate churn due solely to skip messages),
  - no false missing-marker failures,
  - cleanup message matches actual workspace directory state (including partial-success warnings when applicable).

---

## 8) Acceptance criteria

- No stage outcome is finalized from stale/empty response payloads; completion waits for idle + run-scoped `agent_end` (or explicit timeout failure).
- Skip-protocol failures (`Skipped due to queued user message.`) are handled deterministically:
  - one safe retry when no mutating side effects occurred,
  - explicit non-retriable failure when side effects may have occurred.
- No review stage fails with `Missing [STATUS: ...] marker` when marker is present in assistant output.
- Gate no longer enters fix-loop due solely to transient protocol formatting issues.
- Workspace cleanup output truthfully states whether filesystem directory was actually removed, and partial cleanup is clearly surfaced to users.

---

## 9) Decision log

- **Accepted:** Fix reliability in backend semantics and workflow retries together (not either/or).
- **Accepted:** Treat protocol failures as transient/recoverable before escalating to fix loop.
- **Accepted:** Preserve strict marker contract for review stages (`auto_status=true`).
- **Accepted:** Retry protocol failures only when safe (no mutating side effects detected).
- **Accepted:** Prefer structured skip-failure detection; text matching remains fallback.
- **Accepted:** Keep cleanup best-effort behavior, but make result explicit (`partial_success` + warnings) instead of silent success and surface it in user-visible summaries.
- **Accepted:** Defer provider-specific prefill compatibility handling to a separate follow-up plan.
