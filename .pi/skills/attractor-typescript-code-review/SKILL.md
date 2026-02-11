---
name: attractor-typescript-code-review
description: This skill should be used when the user asks to "review TypeScript code", "typescript code quality", "TypeScript idioms check", "review my TypeScript", "check code quality", or wants feedback on TypeScript patterns, typing strategy, and module organization.
---

# TypeScript Code Review

**Action required:** Run `/review typescript code` to start an interactive code quality review. Do not perform the review manually.

---

<!-- The content below is used by the /review command as review instructions -->

Perform a thorough code quality review of TypeScript code, focusing on type safety, maintainability, and clear architecture.

## Scope Determination

First, determine what code to review:

1. **If the user specifies files/directories**: Review those paths
2. **If no scope specified**: Review working changes
   - Check for `.jj` directory first, use `jj diff` if present
   - Otherwise use `git diff` to identify changed `.ts`, `.tsx`, `.mts`, and `.cts` files
   - If no changes, ask the user what to review

## Review Process

1. **Read the target files** using the Read tool
2. **Analyze against the checklist** below
3. **Output findings** in the standard format

## Review Checklist

### Type Safety & API Design
- Avoids `any` and unsafe type assertions (`as unknown as` chains)
- Uses `unknown` for untrusted input with explicit narrowing
- Function signatures are explicit and stable
- Public APIs use strong domain types instead of primitive-heavy signatures
- Optional fields and nullability handled intentionally (`strictNullChecks` mindset)
- Generic constraints are meaningful (`<T extends ...>` when needed)

### Type Narrowing & Control Flow
- Uses type guards, discriminated unions, and exhaustive checks
- `switch`/if branches narrow types correctly
- Uses `never` exhaustiveness checks for union handling
- Avoids non-null assertions (`!`) unless justified with local invariants
- Runtime checks align with type-level expectations

### Idiomatic TypeScript Patterns
- Uses `type`/`interface` consistently and intentionally
- Prefers composition over deep inheritance trees
- Keeps utility types readable (no type-level overengineering)
- Async code uses `async/await` clearly with proper error boundaries
- Side effects separated from pure transformations where feasible

### Module Organization
- Public exports are minimal and intentional
- Internal helpers are not leaked from module boundaries
- File/module names reflect responsibilities
- Avoids cyclic imports and tangled dependencies
- Shared types colocated with domain or API boundaries appropriately

### Readability & Maintainability
- Functions/classes are focused (single responsibility)
- Complex logic has concise explanatory comments
- Naming is descriptive without excessive verbosity
- No dead code, stale TODOs, or unused imports
- Consistent formatting and linting expectations followed

### Error Handling
- Errors include actionable context
- No silent failures (empty `catch`, swallowed Promise rejections)
- Domain errors represented consistently (custom error types or tagged results)
- Validation occurs near system boundaries (request, file, env, external data)

## Output Format

Present findings as:

```markdown
## Findings

### [SEVERITY] Issue Title
**File:** `path/to/file.ts:LINE`
**Category:** quality

**Issue:** Description of what's wrong and why it matters.

**Suggestion:** How to fix, with code example if helpful.

**Effort:** trivial|small|medium|large

---
```

Use severity indicators:
- HIGH: Bugs, incorrect behavior, serious maintainability risks
- MEDIUM: Weak typing, non-idiomatic patterns, unclear structure
- LOW: Style issues, minor cleanup, optional improvements

## Summary

After all findings, provide:
- Total count by severity
- Top 2-3 priority items to address
- Overall code quality assessment (1-2 sentences)
