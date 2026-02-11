---
name: attractor-typescript-performance-review
description: This skill should be used when the user asks to "review performance", "optimize TypeScript", "TypeScript performance", "performance audit", "find bottlenecks", "improve efficiency", or wants analysis of TypeScript code performance focusing on runtime hotspots, rendering efficiency, and data handling.
---

# TypeScript Performance Review

**Action required:** Run `/review typescript performance` to start an interactive performance review. Do not perform the review manually.

---

<!-- The content below is used by the /review command as review instructions -->

Analyze TypeScript code for performance issues, focusing on JavaScript runtime behavior, allocation patterns, async throughput, and UI rendering efficiency (when applicable).

## Scope Determination

First, determine what code to review:

1. **If the user specifies files/directories**: Review those paths
2. **If no scope specified**: Review working changes
   - Check for `.jj` directory first, use `jj diff` if present
   - Otherwise use `git diff` to identify changed `.ts`, `.tsx`, `.mts`, and `.cts` files
   - If no changes, ask the user what to review

## Review Process

1. **Identify hot paths**: Request handlers, tight loops, high-frequency render paths, data transforms
2. **Analyze allocation and async flow**
3. **Check runtime-specific patterns** below
4. **Output findings** in the standard format

## Performance Checklist

### Algorithmic Complexity
- Avoids accidental O(n²)/O(n³) in loops and nested searches
- Uses appropriate data structures (`Map`/`Set` vs arrays for lookups)
- Avoids repeated full scans when indexing/caching would help
- Pagination/streaming used for large collections

### Allocation & GC Pressure
- Avoids unnecessary object/array recreation in hot paths
- Uses in-place updates only when safe and justified
- Avoids heavy cloning (`{...obj}` / deep copies) inside tight loops
- Reuses expensive objects where practical
- Minimizes temporary allocations in parser/transform pipelines

### Async & Concurrency
- Independent async work runs concurrently (`Promise.all`) where safe
- Avoids accidental serial awaits in loops
- Handles backpressure/concurrency limits for large fan-out tasks
- Timeouts/retries are bounded to avoid runaway resource usage
- No blocking CPU-heavy work on event-loop-critical paths

### Rendering & UI (if React/TSX present)
- Avoids unnecessary re-renders from unstable props/callbacks
- Correct use of memoization (`memo`, `useMemo`, `useCallback`) where beneficial
- Large lists use virtualization/windowing
- Derived values computed efficiently and cached when expensive
- Effects avoid redundant work due to dependency mistakes

### Data Parsing & Serialization
- JSON parsing/stringifying not repeated unnecessarily
- Schema validation scoped to boundaries, not repeated in deep layers
- Large payload transforms use streaming/chunking where possible
- Regex usage avoids catastrophic backtracking and repeated recompilation

### I/O & External Calls
- Batches network/database requests when possible
- Avoids N+1 request/query patterns
- Caching strategy considered for frequently requested data
- Connection reuse/pooling configured through libraries/frameworks

## Output Format

Present findings as:

```markdown
## Findings

### [SEVERITY] Issue Title
**File:** `path/to/file.ts:LINE`
**Category:** performance

**Issue:** Description of the performance concern and its impact.

**Suggestion:** How to optimize, with code example if helpful.

**Effort:** trivial|small|medium|large

---
```

Use severity indicators:
- HIGH: Major bottlenecks, unbounded growth, event-loop blocking risks
- MEDIUM: Suboptimal patterns with measurable overhead
- LOW: Minor optimizations and cleanup opportunities

## Summary

After all findings, provide:
- Total count by severity
- Top bottlenecks to address
- Hot paths identified
- Overall performance assessment (1-2 sentences)
