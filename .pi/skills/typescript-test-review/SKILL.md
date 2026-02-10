---
name: typescript-test-review
description: This skill should be used when the user asks for "test review", "test coverage", "improve TypeScript tests", "review tests", "test quality", "testing audit", or wants analysis of TypeScript test suites for coverage gaps, edge cases, and testing best practices.
---

# TypeScript Test Review

**Action required:** Run `/review typescript test` to start an interactive test review. Do not perform the review manually.

---

<!-- The content below is used by the /review command as review instructions -->

Analyze TypeScript test code for coverage gaps, edge case handling, test quality, and framework-appropriate testing practices.

## Scope Determination

First, determine what to review:

1. **If the user specifies test files**: Review those paths
2. **If the user specifies source files**: Find corresponding tests and review coverage
3. **If no scope specified**: Review working changes
   - Check for `.jj` directory first, use `jj diff` if present
   - Otherwise use `git diff` to identify changed files
   - Look at both changed source and test files

Test files are commonly `*.test.ts`, `*.spec.ts`, `*.test.tsx`, or under `__tests__/`.

## Review Process

1. **Map source to tests**: Identify modules/features lacking meaningful coverage
2. **Analyze scenario coverage**: happy path, failure path, boundary conditions
3. **Review test quality** using checklist below
4. **Output findings** in the standard format

## Test Review Checklist

### Coverage Gaps
- Public behavior and critical business logic are tested
- Error and exception paths are covered
- Boundary and edge cases covered (empty, nullish, large inputs, invalid formats)
- Authorization/permission-sensitive logic has explicit tests
- Integration boundaries (DB/API/file/network) have representative tests

### Test Quality
- Tests verify behavior, not private implementation details
- Names describe intent clearly
- Assertions are specific and meaningful
- Tests are deterministic (no timing/race flakiness)
- Setup and teardown are explicit and isolated
- No hidden inter-test dependencies

### Type-Driven Test Practices
- Test fixtures align with actual TypeScript types
- `as any` in tests minimized and justified
- Mocks/stubs preserve contract shape to avoid false confidence
- Runtime validators tested when used for untrusted input

### Framework Patterns (Jest/Vitest/Playwright/etc.)
- Avoids over-mocking that removes behavior under test
- Uses fake timers carefully and restores state
- Async tests await all promises and assert rejection paths
- Snapshot tests are focused and reviewed (not overly broad)
- E2E tests focus on critical flows and failure cases, not only happy paths

### Edge Cases & Robustness
- Empty collections/strings, null/undefined, malformed input
- Concurrency/race scenarios where relevant
- Retry/timeout/fallback behavior tested
- Idempotency and duplicate request handling tested where applicable
- Error mapping and user-visible failure responses validated

### Property-Based / Fuzz Opportunities
Identify logic that would benefit from generated input testing:
- Parsers, validators, normalizers
- Serialization/deserialization roundtrip behavior
- Business invariants over wide input spaces

## Output Format

Present findings as:

```markdown
## Findings

### [SEVERITY] Issue Title
**File:** `path/to/file.test.ts:LINE` (or source file if missing tests)
**Category:** testing

**Issue:** Description of the testing gap or quality issue.

**Suggestion:** What to test or how to improve, with example if helpful.

**Effort:** trivial|small|medium|large

---
```

Use severity indicators:
- HIGH: Critical untested paths, missing failure/security tests
- MEDIUM: Important edge cases missing, weak assertions
- LOW: Organization and incremental quality improvements

## Summary

After all findings, provide:
- Total count by severity
- Coverage summary (areas with/without adequate tests)
- Top testing priorities
- Overall test suite assessment (1-2 sentences)
