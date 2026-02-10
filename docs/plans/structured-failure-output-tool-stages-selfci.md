---
title: Structured Failure Output for Tool Stages (selfci focus)
date: 2026-02-10
goal: Let's come up with a plan for the TODO.md item Structured failure output for tool stages (esp. `selfci`)
status: approved
---

# Structured Failure Output for Tool Stages (`selfci` focus)

## Summary

Implement structured tool-stage failure output so users get actionable diagnostics instead of generic `Command failed` strings.

Scope is intentionally tight:

- Persist full artifacts for every attempt (`stdout.log`, `stderr.log`, `meta.json`)
- Emit structured failure data from tool stages into engine events/results
- Improve CLI stage + final failure summaries
- Add **best-effort** digest parsing (focus on `selfci`, with safe fallback)
- Use **plain command string** for rerun guidance

No backward-compatibility work is required.

## Files to Change

1. **`src/pipeline/types.ts`**
   - Define/adjust failure types for tool-stage failures:
     - `failureClass`
     - `digest`
     - `command`
     - exit/signal + duration
     - stdout/stderr tails
     - artifact/log paths
     - optional `firstFailingCheck`
   - Update pipeline-result failure summary fields:
     - `failedNode`
     - `failureClass`
     - `firstFailingCheck`
     - `rerunCommand`
     - `logsPath`

2. **`src/pipeline/handlers.ts`**
   - Update `ToolHandler` execution to always write attempt artifacts.
   - Return structured failure payload with:
     - class (`exit_nonzero`, `timeout`, `spawn_error`, etc.)
     - digest
     - plain command string
     - cwd, exitCode, signal, durationMs
     - stdoutTail, stderrTail
     - per-attempt artifact paths

3. **`src/pipeline/engine.ts`**
   - Propagate structured failure payload into `stage_failed`.
   - Build final pipeline failure summary from first failed stage.

4. **`src/cli.ts`**
   - Use structured `stage_failed` data for concise per-stage failure line + log path.
   - Use final pipeline failure summary for end-of-run failure block.

5. **`src/cli-renderer.ts`**
   - Render failure summary fields:
     - failed node
     - failure class
     - first failing check (if present)
     - rerun command (plain command)
     - logs path

6. **`src/pipeline/tool-failure.ts`** (new)
   - Best-effort digest extraction helper.
   - Start with simple `selfci` extraction + generic fallback.
   - Keep heuristics minimal; do not overfit.

7. **Tests**
   - `src/pipeline/handlers.test.ts`
   - `src/pipeline/engine.test.ts`
   - `src/cli.test.ts`
   - `src/cli-renderer.test.ts`
   - `src/pipeline/tool-failure.test.ts` (new)

## Approach

1. **Artifact-first tool execution**
   - For every tool run attempt, persist:
     - `stdout.log`
     - `stderr.log`
     - `meta.json`
   - Ensure logs are split by attempt so retries keep distinct artifacts.
   - Keep short tails in memory for diagnostics/events; rely on files for full output.

2. **Structured failure model**
   - On tool-stage failure, return structured details including class, digest, command, runtime metadata, and log paths.
   - Keep success path unchanged.

3. **Digest extraction (best-effort)**
   - Detect `selfci` command family and extract concise failure digest.
   - Try to extract `firstFailingCheck` when confidently present.
   - If parsing fails, fallback to generic digest from exit status + relevant stderr/stdout line.

4. **Engine/event propagation**
   - Include structured failure details in `stage_failed` events.
   - Include final failure summary fields in pipeline result based on the first failed stage.

5. **CLI rendering updates**
   - Per-stage failure: one-line digest + log pointer.
   - Final failure summary: failed node/class/check/rerun command/logs path.
   - Avoid dumping large stderr directly in terminal output.

## Edge Cases

1. **Large output**: store full logs on disk, show only tails/digest in terminal.
2. **Failure class distinction**: non-zero exit, timeout, and spawn/setup errors must classify separately.
3. **No stderr primary signal**: parser checks both stderr and stdout.
4. **Retry attempts**: artifacts must remain deterministic and preserved per attempt.
5. **Missing cwd/input anomalies**: record effective cwd in metadata and keep digest non-empty.
6. **Non-tool failures**: final summary should still degrade gracefully if failure did not originate from a tool stage.

## Test Cases

1. **Tool success artifacts**
   - Writes `stdout.log`, `stderr.log`, `meta.json` for each attempt and reports success.

2. **Structured tool failure payload**
   - Includes failure class, digest, command, exit metadata, tails, and artifact paths.

3. **`selfci` digest extraction**
   - Extracts a concise digest and first failing check when available.

4. **Fallback digest behavior**
   - Unknown tool output still yields a useful one-line digest.

5. **Timeout classification**
   - Timeout failures are distinctly classified with timeout metadata.

6. **Engine propagation**
   - `stage_failed` contains structured fields.
   - Pipeline failure result includes failed node + class + rerun/log summary fields.

7. **CLI stage output**
   - Shows concise failure + log pointer without flooding output.

8. **CLI final summary**
   - Renders failed node, class, optional failing check, rerun command, and logs path.

9. **Retry artifact behavior**
   - Multiple attempts preserve separate artifact directories/files.

## Decision Log

- **Revision:** switched to **per-attempt artifact storage** to avoid overwrite/loss across retries.
- **Revision:** reduced parser scope to **best-effort** extraction, with `selfci` focus and robust fallback.
- **Revision:** dropped backward-compatibility requirements for legacy failure fields.
- **Revision:** standardized rerun guidance on a **plain command string** instead of shell snippet wrapping.
