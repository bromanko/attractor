# AGENTS.md

Guidance for coding agents working in this repository.

## Project at a glance

- **Name:** `attractor`
- **Language:** TypeScript (ESM, NodeNext)
- **Runtime:** Node.js >= 20
- **Build output:** `dist/`
- **Main areas:**
  - `src/llm/` — unified LLM client
  - `src/agent/` — coding-agent loop
  - `src/pipeline/` — DOT pipeline engine

## Environment

This repo is managed via **Nix flakes**.

- Preferred: enter the dev shell with `nix develop`
- Or use `direnv` (auto-loads `.envrc`) if configured locally

Run build/test/selfci commands from within that environment.

## Working rules

> **Pre-release policy:** This project is pre-release. Backward compatibility is **not required** unless a task explicitly asks for it.

1. Keep changes focused and minimal.
2. Prefer small, composable functions and explicit types.
3. Follow current naming and module organization patterns in nearby files.
4. Do not edit generated output in `dist/` directly.

## Dev commands

- Install deps: `npm install`
- Build: `npm run build`
- Type-check: `npm run lint`
- Test (all): `npm test`
- Test (integration): `npm run test:integration`
- Test (watch): `npm run test:watch`
- SelfCI: `selfci`

## Validation checklist (before finishing)

Run, at minimum:

1. `npm run lint`
2. `npm test`
3. `selfci`

If the change is isolated and full tests are expensive, run the most relevant test subset and state what was run.

## Code style expectations

- TypeScript `strict` mode is enabled: avoid `any` and unsafe casts.
- **Test mocks must be typed against their real interfaces** (e.g., `const interviewer: Interviewer = { ... }`). Never use `as any` to silence type mismatches on mocks — this defeats the purpose of type checking and hides breakage when interfaces change.
- Keep modules ESM-compatible (`"type": "module"`, NodeNext).
- Prefer discriminated unions and narrow types for state/result modeling.
- **Use narrow string-literal unions instead of `string` when the set of valid values is known.** For example, a field that accepts a boolean or its DOT-string representation should be typed `boolean | "true" | "false"`, not `boolean | string`. Overly broad types mask configuration errors at compile time.
- **Use named constants for cross-module context/config keys.** Never scatter magic string literals across files. See `HUMAN_GATE_KEYS` in `src/pipeline/types.ts` as the pattern — define a `const` object in a shared location and import it everywhere the keys are read or written.
- Keep error handling explicit; return structured error data where appropriate. **Never use bare `catch {}` or `catch { /* ignore */ }` to swallow errors silently.** At minimum log a warning. Better yet, avoid the need — e.g., store structured values in `Context` natively (using `get`/`set` with typed accessors like `getStringArray`) instead of serializing to JSON strings and parsing them back.
- Add or update tests in `test/` when behavior changes.

## When editing architecture-critical areas

For changes touching parsing/execution/model behavior (especially under `src/pipeline/`):

- Maintain deterministic behavior (edge selection, routing, condition evaluation).
- Backward compatibility of DOT parsing is optional in this pre-release phase; prefer clarity and correctness.
- Add focused regression tests for bug fixes and edge cases.

## Commit guidance

Use clear, scoped commit messages, e.g.:

- `pipeline: fix conditional edge tie-break with weights`
- `agent: add truncation guard for tool stderr`
- `llm: improve retry handling for 429 responses`
