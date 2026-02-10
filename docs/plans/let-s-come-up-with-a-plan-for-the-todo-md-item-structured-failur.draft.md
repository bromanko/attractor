1. ## Summary

Implement structured failure handling for **tool stages** (especially `selfci`) so failures are actionable instead of generic `Command failed` strings.  
Concretely: capture full stage artifacts (`stdout.log`, `stderr.log`, `meta.json`), extract a concise failure digest, surface structured fields in engine events/results, and improve CLI stage + final failure summaries (failed node, failure class, first failing check, rerun command, log paths).

---

2. ## Files to change

1. **`src/pipeline/types.ts`**  
   - Add typed failure payloads (tool failure details + optional pipeline failure summary fields) while keeping `failure_reason` for backward compatibility.

2. **`src/pipeline/handlers.ts`**  
   - Rework `ToolHandler` execution to persist artifacts and return structured failure details.  
   - Include command/cwd/exit/signal/duration/stdout+stderr tails and log paths.

3. **`src/pipeline/engine.ts`**  
   - Propagate structured failure payload into `stage_failed` events and pipeline result metadata.  
   - Track failed node + failure class for final summary.

4. **`src/cli.ts`**  
   - Consume structured `stage_failed` data for one-line digest + log pointer output.  
   - Use enriched pipeline result to print improved final failure summary.

5. **`src/cli-renderer.ts`**  
   - Extend summary rendering for failure metadata (failed node, class, first failing check, rerun command).  
   - Keep normal success/cancelled output unchanged.

6. **(Likely new) `src/pipeline/tool-failure.ts` + tests**  
   - Centralize digest extraction logic (`selfci`, `tsc`, `vitest`, `nix`, fallback).  
   - Add noise filtering rules (e.g., non-fatal SQLite busy warnings).

7. **Tests**
   - `src/pipeline/handlers.test.ts`
   - `src/pipeline/engine.test.ts`
   - `src/cli.test.ts`
   - `src/cli-renderer.test.ts`
   - (new) `src/pipeline/tool-failure.test.ts`

---

3. ## Approach

1. **Artifact-first tool execution**
   - In `ToolHandler`, for every run:
     - Create stage log dir (`<logsRoot>/<nodeId>/...`).
     - Persist:
       - `stdout.log`
       - `stderr.log`
       - `meta.json` (command, cwd, start/end, duration, exitCode/signal, timeout flag, log file paths, digest fields)
   - Store short tails in memory for diagnostics (not full output in event payload).

2. **Structured failure model**
   - On failure, return `Outcome` with:
     - `status: "fail"`
     - `failure_reason`: one-line digest (legacy path for existing consumers)
     - `failure_details`: typed object (class + structured fields)
   - Keep success behavior and context routing unchanged.

3. **Digest extraction**
   - Determine tool family from command (`selfci`, `tsc`, `vitest`, `nix`, fallback).
   - Parse stderr/stdout tail to extract:
     - `failureDigest` (single line)
     - `firstFailingCheck` (if detectable)
     - optional `noiseWarnings` (ignored from primary cause)
   - Fallback digest if no parser match: `Command failed (exit X)` + top relevant stderr line.

4. **Engine + event propagation**
   - Include structured failure details in `stage_failed` event data.
   - Include top-level failure summary fields in `PipelineResult` on fail:
     - `failedNode`
     - `failureClass`
     - `firstFailingCheck`
     - `rerunCommand`
     - `logsPath`

5. **CLI rendering updates**
   - Stage failure line: concise digest (single line), then log location.
   - Final summary on fail: include failed node/class/check/rerun command + logs root.
   - Preserve current spinner and markdown behavior; don’t dump huge stderr inline.

---

4. ## Edge cases

1. **Large output**: avoid truncation surprises; tails for display, full logs on disk.
2. **Timeout vs non-zero exit vs spawn error (`ENOENT`)**: classify distinctly.
3. **No stderr, only stdout failure signal**: digest parser must inspect both.
4. **Noisy warnings**: avoid promoting known non-fatal lines as primary failure.
5. **Retries**: ensure artifact naming strategy doesn’t lose previous attempt logs.
6. **Non-tool failures**: summary still works when failure comes from codergen/workspace/goal gate.
7. **Missing workspace cwd**: fallback to process cwd and record effective cwd in meta.

---

5. ## Test cases

1. **Tool success artifacts**
   - Writes `stdout.log`, `stderr.log`, `meta.json`; status success.

2. **Tool failure structured payload**
   - Failure outcome includes class, exit code, command, cwd, duration, tails, logs paths.
   - `failure_reason` is concise digest (not raw `Error: Command failed`).

3. **Selfci digest extraction**
   - Captures first failing check from representative `selfci` output.
   - Filters known noise warnings.

4. **Fallback digest**
   - Unknown tool failure still produces useful one-line digest + rerun command.

5. **Timeout classification**
   - Timeout marked as timeout class with signal/time metadata.

6. **Engine event propagation**
   - `stage_failed` event contains structured failure fields.
   - Pipeline fail result includes failed node + failure class.

7. **CLI stage output**
   - Displays digest and log path; does not flood terminal with full stderr.

8. **CLI final summary**
   - On fail, includes failed node, class, first failing check, rerun command.

9. **Retry artifact behavior**
   - Multiple attempts preserve distinguishable logs/meta.

---

6. ## Open questions

1. **Per-attempt log layout**: overwrite `stdout.log`/`stderr.log` or store `attempt-N/` artifacts?
2. **Digest parser strictness**: how broad should tool-specific heuristics be initially?
3. **Noise warning policy**: hardcoded patterns vs configurable list?
4. **Rerun command format**: exact shell snippet (`cd <cwd> && <cmd>`) vs plain command string?
5. **Public API impact**: are optional `PipelineResult`/`Outcome` fields acceptable without versioning note?