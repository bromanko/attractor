---
title: Architecture Hardening & Parser Safety
date: 2026-02-14
goal: Fix the non-TODO design/implementation issues found in review
status: proposed
---

# Architecture Hardening & Parser Safety

## Summary

This plan addresses the review findings **excluding existing TODO.md items**:

1. Package/docs/API contract mismatch (`./agent`, `./llm` exports/docs vs current codebase)
2. Unsafe KDL comment stripping (breaks URLs and `//` in strings)
3. `re_review` boolean coercion bug (`"false"` becomes truthy)
4. Silent error swallowing in `catch {}` blocks
5. Build reproducibility risk from stale `dist/` artifacts
6. AGENTS guidance update to prevent swallowed errors going forward

---

## Scope

### In scope
- `package.json` export cleanup and scripts hardening
- README architecture/API updates to match current implementation
- KDL tokenizer/parser fix for comment handling
- Human-stage `re_review` parsing correctness
- Replace/annotate bare catches with explicit warning or structured handling
- Strengthen `AGENTS.md` rules and repo-at-a-glance accuracy
- Tests covering all changed behavior

### Out of scope
- TODO.md items already tracked (resume routing correctness, findings accumulation, etc.)
- Backward compatibility guarantees (pre-release policy applies)

---

## Work Plan

## Phase 1 — Align public contract (exports/docs/build)

### Changes
- `package.json`
  - Remove stale subpath exports for `./llm` and `./agent`.
  - Harden build path so stale artifacts cannot hide missing modules:
    - update `build` to run `clean` first, or add `prebuild: npm run clean`.
    - add `prepack` to run a clean build and tests (or at least lint + build).
- `README.md`
  - Remove/replace references to now-absent `src/llm`, `src/agent`, and related imports.
  - Update architecture section to reflect current structure (`pipeline`, CLI, extension, `PiBackend`).
- `AGENTS.md`
  - Update “Project at a glance” main areas to match current `src/` layout.

### Tests/validation
- `npm run clean && npm run build`
- verify `node -e 'import("./dist/index.js")'` succeeds
- ensure no docs reference non-existent public entry points

---

## Phase 2 — Fix KDL parser correctness

### Problem
Current `stripComments()` regex removes `//` even inside quoted strings, causing parse failures for valid prompts like URLs.

### Changes
- `src/pipeline/workflow-kdl-parser.ts`
  - Remove regex pre-strip approach.
  - Handle comments lexically in tokenizer:
    - recognize `//...` and `/* ... */` **only when not inside a quoted string**.
    - preserve all string content exactly (including `https://...`).
  - Keep current line/col error reporting behavior.

### Tests
- `src/pipeline/workflow-kdl-parser.test.ts`
  - add regression: URL in `prompt` parses successfully
  - add regression: block-comment markers inside string are not treated as comments
  - keep existing comment handling tests (outside strings)

---

## Phase 3 — Fix `re_review` coercion bug

### Problem
`Boolean(reReviewNode.args[0])` treats string `"false"` as true.

### Changes
- `src/pipeline/workflow-kdl-parser.ts`
  - introduce strict scalar-to-boolean parsing helper for `re_review` node
  - accept only boolean tokens (`true` / `false`) for this field
  - reject invalid scalar types with explicit conversion error

### Tests
- `src/pipeline/workflow-kdl-parser.test.ts`
  - `re_review true` → `true`
  - `re_review false` → `false`
  - `re_review "false"` should fail fast (or parse to false if explicitly chosen policy; pick one and document)

---

## Phase 4 — Eliminate silent catch blocks

### Changes
- Audit and update bare catches in:
  - `src/pipeline/engine.ts`
  - `src/pipeline/handlers.ts`
  - `src/pi-backend.ts`
- Replace each `catch {}` with one of:
  - `catch (err) { console.warn(...) }` (best-effort branch)
  - structured warning event/context log where available
  - explicit comment + documented rationale only when truly safe/no-op
- Keep behavior non-fatal where intended (cleanup/telemetry paths), but observable.

### Tests
- Add targeted tests for at least one warning path in each module where practical.
- Ensure no output-based tests become flaky (assert on stable substrings or mocked logger calls).

---

## Phase 5 — Prevent regressions (policy + checks)

### AGENTS.md update
- Keep existing “no bare catch” rule and make it enforceable by adding:
  - “Every catch must bind an error variable (`catch (err)`) unless language constraints prevent it.”
  - “Best-effort catches must emit a warning with stage/module context.”
  - “Do not introduce new silent catches in engine/handler/backend code paths.”

### Optional enforcement (recommended)
- Add ESLint rule (`no-empty`) if lint stack is introduced later.
- Until then, add CI grep guard for `catch {` and `catch { /* ignore */ }` patterns.

---

## Acceptance Criteria

- No stale `./agent` / `./llm` exports or docs references remain.
- Parser accepts `https://...` and comment-like text inside strings.
- `re_review` parsing is type-correct and covered by tests.
- No bare silent catches remain in touched runtime modules.
- `AGENTS.md` reflects current architecture and explicit catch-handling policy.
- Validation passes:
  - `npm run lint`
  - `npm test`
  - `selfci`

---

## Suggested PR breakdown

1. **contract/docs:** package exports + README + AGENTS structure refresh
2. **parser:** lexical comment handling + tests
3. **human-gate parsing:** `re_review` boolean fix + tests
4. **error handling policy:** catch-block cleanup + AGENTS hardening + regression checks
