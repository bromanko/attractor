---
title: "Plan: User-friendly workflow resume flow (CLI + Pi)"
slug: "resume-flow-cli-pi"
status: "approved"
created_at: "2026-02-15"
updated_at: "2026-02-15"
owner: "attractor"
---

## Summary

Implement a run-history-backed resume UX centered on `run --resume` so users can easily discover resumable runs and choose the right one in both CLI and Pi.

Key outcomes:
- Resume supports both **cancelled** and **failed** runs.
- Resume remains under **`run --resume`** (no dedicated resume command).
- CLI and Pi share the same resume selector semantics.
- Successful runs are cleaned up from the resumable set.

## Files to change

- `src/cli.ts`
  - Extend `run --resume` handling for run selector values and preflight output.
- `src/cli-renderer.ts`
  - Add richer resume rendering and resumable-run list/picker text helpers.
- `src/extensions/attractor-command.ts`
  - Parse shared resume selector syntax (`--resume` and `--resume <selector>`).
- `src/extensions/attractor.ts`
  - Add Pi picker flow for resumable runs and resume confirmation preview.
- `src/pipeline/engine.ts`
  - Wire run status/metadata updates through run lifecycle.
- `src/pipeline/types.ts` (if shared types/constants are needed)
- `src/pipeline/run-history.ts` (new)
  - Run metadata schema and helpers for discovery/filtering/selection.

Tests:
- `src/cli.test.ts`
- `src/cli-renderer.test.ts`
- `src/extensions/attractor-command.test.ts`
- `src/extensions/attractor.test.ts`
- `test/integration/integration.test.ts`

Docs:
- `README.md`
- `docs/attractor-extension.md`

## Approach

1. **Run-history model**
   - Add a per-run metadata record including `runId`, workflow info, goal, timestamps, status, last node, checkpoint path, and logs root.
   - Mark a run as resumable only when status is `cancelled` or `fail` and checkpoint exists.

2. **Storage layout**
   - Store run metadata under `<logs>/runs/<runId>/...`.
   - Use scanning/index helper methods in `run-history.ts` to find resumable runs.

3. **Shared selector syntax**
   - Support identical semantics in CLI and Pi:
     - `--resume` (no value): select latest resumable run.
     - `--resume <runId>`: resolve by exact/prefix run id.
     - `--resume <path>`: explicit checkpoint path (power-user/backward-compatible path).

4. **CLI flow**
   - Resolve resume target via shared helper.
   - Print resume preflight summary (run ID, workflow, goal, last node, updated time, checkpoint path).
   - Continue into existing `runPipeline` checkpoint flow.

5. **Pi flow**
   - Reuse selector resolution logic.
   - If no explicit selector, show interactive picker of resumable runs.
   - Show confirmation preview before launch.

6. **Cleanup policy**
   - On `success`, remove/archive run from active resumable history so users only see failed/cancelled resume candidates.
   - Log warnings on cleanup failures (no silent error swallowing).

## Edge cases

- No resumable runs found.
- Selector ambiguity (prefix matches multiple runs).
- Run metadata exists but checkpoint is missing.
- Corrupt metadata/checkpoint JSON.
- Checkpoint points to removed node after workflow changes.
- Selector references successful/non-resumable run.
- Pi picker cancellation by user.
- Cleanup-on-success fails due to filesystem permissions/errors.

## Test cases

1. **CLI parsing and resolution**
   - `run <wf> --resume` resolves latest resumable run.
   - `run <wf> --resume <runId>` resolves exact/prefix.
   - `run <wf> --resume <checkpoint-path>` remains supported.

2. **CLI UX behavior**
   - No resumable runs yields actionable error.
   - Ambiguous selector yields disambiguation error.
   - Resume preflight summary includes expected run fields.

3. **Pi UX behavior**
   - `run --resume` opens picker and resumes selected run.
   - Picker cancel exits without starting pipeline.
   - `run --resume <selector>` bypasses picker when uniquely resolved.

4. **Lifecycle behavior**
   - Failed/cancelled runs remain discoverable as resumable.
   - Successful resumed run is removed/archived from active resumable set.

5. **Integration scenarios**
   - fail -> resume success
   - cancelled -> resume success
   - missing/corrupt checkpoint surfaces clear error
   - workflow-modified node-missing resume error is surfaced clearly in CLI and Pi

## Open questions

- For `--resume` with no value in CLI, always auto-select latest vs prompt when multiple runs exist?
- Should successful runs be hard-deleted from run history or archived for audit/debug?
- Should run-id prefix matching enforce a minimum prefix length?

## Decision log

- **Accepted**: resumable runs include both `cancelled` and `fail`.
- **Accepted**: use `run --resume` rather than adding a dedicated resume command.
- **Accepted**: share selector syntax across CLI and Pi.
- **Accepted**: avoid dual-write migration complexity; proceed with new run-history approach.
- **Accepted**: clean up successful runs so active resume list contains only failed/cancelled runs.
