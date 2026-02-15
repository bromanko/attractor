# Plan: Review Findings Accumulation

## 1. Summary

When multiple review stages run in sequence and some fail, the `fix` node
currently has to piece together what went wrong from individual
`${reviewId}.response` / `${reviewId}.status` context keys scattered across the
context snapshot.  Worse, when the pipeline short-circuits (e.g. `review_code`
fails → gate → fix), later reviews (`review_security`, `review_perf`,
`review_tests`) never run, so their findings are absent — the fix addresses
only the first failure, then loops back, potentially requiring many iterations
to surface all issues.

This plan introduces a **`review.findings` context key** — a structured,
accumulating list that review stages automatically append to when they produce a
non-success outcome.  The fix node's prompt is enriched with these aggregated
findings so it can address everything in a single pass (when all reviews run),
and the accumulated history provides cross-iteration context even when reviews
short-circuit.

## 2. Files to Change

| File | Change |
|---|---|
| `src/pipeline/types.ts` | Add `ReviewFinding` type, `REVIEW_FINDINGS_KEY` constant, and `appendToArray` helper on `Context` |
| `src/pipeline/engine.ts` | After a review-eligible stage completes with `fail`/`partial_success`, append a `ReviewFinding` to `review.findings`; clear stale findings for a stage when it re-runs successfully |
| `src/pi-backend.ts` | In `buildContextSummary`, render `review.findings` as a dedicated "## Review Findings" section with structured output so the fix node sees a clean, prioritised list |
| `.attractor/workflows/implement-plan.awf.kdl` | Update `fix` stage prompt; make review transitions unconditional so all reviews run even on failure |
| `.attractor/workflows/quick-dev.awf.kdl` | Same prompt + transition updates |
| `test/integration/workflows/multi-review.awf.kdl` | Add `auto_status=true` to review stages; make transitions unconditional to match production workflows |
| `test/integration/integration.test.ts` | Add tests for findings accumulation scenarios |
| `src/pipeline/engine.test.ts` | Unit tests for accumulation/clearing logic |
| `TODO.md` | Mark the item as done |

## 3. Approach

### 3.1 New Types (`src/pipeline/types.ts`)

```ts
/** A single review finding captured from a review stage. */
export type ReviewFinding = {
  /** The review stage node ID that produced this finding. */
  stageId: string;
  /** The iteration number (1-indexed) — increments each time the stage runs. */
  iteration: number;
  /** Status the review produced (fail, partial_success). */
  status: StageStatus;
  /** The failure reason extracted from the review outcome. */
  failureReason: string;
  /** Full response text containing the detailed findings (from `_full_response`). */
  response: string;
  /** ISO timestamp when the finding was recorded. */
  timestamp: string;
};

/** Well-known context key for accumulated review findings. */
export const REVIEW_FINDINGS_KEY = "review.findings" as const;
```

Add a `appendToArray` method on `Context`:

```ts
/** Append a value to a context key that holds an array, creating it if absent. */
appendToArray(key: string, value: unknown): void {
  const existing = this._values[key];
  if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    this._values[key] = [value];
  }
}
```

### 3.2 Engine Accumulation Logic (`src/pipeline/engine.ts`)

After the handler executes and the outcome is recorded, add a new block that
checks whether the completed node is a **review-eligible stage** and, if so,
manages the findings list:

**Criteria for "review-eligible":** The node has `auto_status=true` (or
`"true"`).  This is the existing marker that distinguishes review/verification
nodes from implementation nodes.  No new attributes needed.

**On fail / partial_success:**
```ts
if (isReviewEligible(node) && (outcome.status === "fail" || outcome.status === "partial_success")) {
  const finding: ReviewFinding = {
    stageId: node.id,
    iteration: /* count how many times this stage has run */,
    status: outcome.status,
    failureReason: outcome.failure_reason ?? "",
    response: context.getString(`${node.id}._full_response`)
              || context.getString(`${node.id}.response`),
    timestamp: new Date().toISOString(),
  };
  context.appendToArray(REVIEW_FINDINGS_KEY, finding);
}
```

**On success (re-run after fix):** Remove any prior findings for this stage ID
from the array so the fix node doesn't re-address already-fixed issues:
```ts
if (isReviewEligible(node) && outcome.status === "success") {
  const existing = context.get(REVIEW_FINDINGS_KEY);
  if (Array.isArray(existing)) {
    context.set(
      REVIEW_FINDINGS_KEY,
      existing.filter((f: ReviewFinding) => f.stageId !== node.id),
    );
  }
}
```

**Helper:**
```ts
function isReviewEligible(node: GraphNode): boolean {
  return node.attrs.auto_status === true || node.attrs.auto_status === "true";
}
```

### 3.3 Tool Stage Findings

Tool stages (like `selfci`) that fail should also contribute to findings, since
the `fix` prompt references "CI and review findings."  The engine block above
can be extended:

```ts
const isToolStage = node.attrs.shape === "parallelogram" || node.attrs.type === "tool";
if ((isReviewEligible(node) || isToolStage) && isFailed) {
  // ... append finding (using tool_failure.digest for failureReason,
  //     tool_failure.stdoutTail + stderrTail for response)
}
```

On tool success, similarly clear prior tool findings for that stage.

### 3.4 Context Summary Rendering (`src/pi-backend.ts`)

In `buildContextSummary`, detect `review.findings` and render it as a
structured section instead of dumping the raw JSON array:

```ts
const findings = snapshot[REVIEW_FINDINGS_KEY];
if (Array.isArray(findings) && findings.length > 0) {
  summary += "\n\n## Outstanding Review Findings\n\n";
  for (const f of findings as ReviewFinding[]) {
    summary += `### ${f.stageId} (${f.status})\n`;
    summary += `**Reason:** ${f.failureReason}\n\n`;
    summary += f.response + "\n\n---\n\n";
  }
}
```

Exclude `review.findings` from the generic key dump to avoid duplication.

### 3.5 Workflow Prompt Updates

Update the `fix` stage prompts to be explicit:

```
"Fix all outstanding issues listed in the review findings below. Address every finding. Commit your fixes incrementally."
```

The context summary already includes the structured findings section, so the fix
node doesn't need `$review.findings` variable expansion — the information is
injected via `buildContextSummary`.  However, mentioning "review findings below"
in the prompt makes the LLM attend to that section.

### 3.6 Checkpoint Compatibility

`review.findings` is a regular context value stored via `context.set()`, so it
is already captured in `checkpoint.context_values` and restored on resume.  No
checkpoint format changes needed.  The array contains only plain objects
(strings, numbers) so JSON round-tripping is safe.

## 4. Edge Cases

1. **No review stages in workflow** — `review.findings` is never created.
   `buildContextSummary` skips the section.  No behaviour change.

2. **All reviews pass** — Findings array stays empty (or entries are removed
   as stages pass).  Fix node is never reached.  No impact.

3. **Review passes on re-run** — The success-path clearing removes stale
   findings for that stage.  The fix node won't re-address already-resolved
   issues.

4. **Multiple iterations** — Each iteration appends new findings with
   incrementing `iteration` numbers.  Old findings for the same stage are
   cleared when the stage passes, preventing unbounded growth.

5. **All reviews run regardless of individual outcomes** — With the updated
   unconditional transitions, every review stage executes even if an earlier
   one fails.  All findings are accumulated before the gate routes to fix.
   The fix node sees the complete picture in a single pass.

6. **Checkpoint resume mid-review-chain** — Findings accumulated before the
   checkpoint are restored.  The resumed run continues accumulating normally.

7. **Mixed tool + review failures** — Both contribute findings.  The fix node
   sees selfci failures alongside review findings in a unified list.

8. **Very large review responses** — The `ReviewFinding.response` field
   carries the full `_full_response` text.  `buildContextSummary` rendering
   may truncate for display, but the fix node has full access.  Worst case
   with 4 lengthy reviews is bounded by LLM context — if that becomes an
   issue, truncation can be added later as a targeted optimisation.

9. **`response_key_base` override** — When a stage uses `response_key_base`
   (e.g. `plan_revise` writes to `plan.response`), the finding captures the
   response from the overridden key.  The engine reads
   `context.getString(getResponseKeyBase(node) + ".response")`.

## 5. Test Cases

### Unit Tests (`src/pipeline/engine.test.ts`)

1. **`Context.appendToArray` creates array if absent** — Call on empty context,
   verify array with single element.

2. **`Context.appendToArray` appends to existing array** — Call twice, verify
   both elements present.

3. **`isReviewEligible` returns true for auto_status=true** — Both boolean
   `true` and string `"true"`.

4. **`isReviewEligible` returns false for regular codergen nodes** — No
   `auto_status`, or `auto_status=false`.

### Integration Tests (`test/integration/integration.test.ts`)

5. **Findings accumulated across multiple failing reviews** — Run
   `multi-review.awf.kdl` with rev1 and rev2 both failing (rev2 auto_status
   added to test workflow).  Verify `review.findings` has entries for both.

6. **Findings cleared when review passes on re-run** — rev1 fails first pass,
   passes second.  Verify rev1 finding removed from `review.findings` after
   second pass.

7. **Fix node receives aggregated findings in context** — Capture the prompt
   sent to the fix backend and verify it contains findings from all failing
   reviews.

8. **Tool stage failure contributes to findings** — selfci fails, verify
   `review.findings` contains a tool failure entry with digest info.

9. **No findings when all reviews pass** — All reviews succeed.  Verify
   `review.findings` is empty/absent and fix never runs.

10. **Checkpoint preserves findings** — Accumulate findings, save checkpoint,
    restore, verify findings survive round-trip.

### Context Summary Tests (`src/pi-backend.test.ts`)

11. **`buildContextSummary` renders findings section** — Populate
    `review.findings` in context, verify output contains structured
    "Outstanding Review Findings" section.

12. **`buildContextSummary` excludes findings from generic dump** — Verify
    `review.findings` doesn't appear as a raw JSON blob in the generic
    key-value section.

## 6. Decisions (formerly Open Questions)

1. **No opt-out for auto-accumulation.** Accumulation is always on for
   `auto_status=true` stages and tool stages.  No per-stage override attribute.

2. **Run all reviews even when an earlier one fails.** Update the default
   workflow transitions in `implement-plan.awf.kdl` and `quick-dev.awf.kdl`
   so that review stages always proceed to the next review regardless of
   outcome.  The gate then checks all outcomes and routes to fix if any
   failed.  This maximises the benefit of accumulation — the fix node sees
   ALL issues in a single pass instead of discovering them one at a time
   across multiple loop iterations.

   Concretely, change transitions like:
   ```
   transition from="review_code" to="review_security" when="outcome(\"review_code\") == \"success\""
   transition from="review_code" to="gate" when="outcome(\"review_code\") != \"success\""
   ```
   to unconditional:
   ```
   transition from="review_code" to="review_security"
   ```
   The gate's existing multi-outcome check handles the routing.

   Also update `multi-review.awf.kdl` test workflow to match.

3. **Include the full `_full_response` in findings.** The fix node needs the
   complete review output to act on detailed findings (file paths, code
   snippets, line numbers).  The `_full_response` is already in context; the
   `ReviewFinding.response` field should reference it without truncation.
   The `buildContextSummary` rendering can still truncate for display, but
   the structured finding should carry the full text so the LLM has access
   to everything.

4. **Both `fail` and `partial_success` contribute findings.** `partial_success`
   means "not fully passing" — findings from those reviews are actionable and
   should be surfaced to the fix node.
