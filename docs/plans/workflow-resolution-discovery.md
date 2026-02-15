---
title: Workflow Resolution Discovery
slug: workflow-resolution-discovery
status: approved
date: 2026-02-15
owners:
  - attractor
summary: >-
  Introduce a shared workflow resolution/discovery module used by both CLI and
  Pi extension, with deterministic precedence across known Attractor workflow
  folders and filename-based deduplication.
---

## 1) Summary

Implement a **shared workflow resolution/discovery module** used by both the standalone CLI and the Pi extension, with Pi-like deterministic discovery behavior but scoped to **Attractor-owned locations only**.

Constraints:
- Do **not** use `.pi/workflows`
- Do **not** add configurable search paths
- Use only known Attractor locations
- Deduplicate by workflow filename (stem from `*.awf.kdl`)
- Deterministic resolution order
- Emit warnings when duplicates exist and one is selected by precedence
- No caching layer

## 2) Files to change

- **New:** `src/pipeline/workflow-resolution.ts`
  - Shared resolver/discovery logic for CLI + extension.
- **New:** `src/pipeline/workflow-resolution.test.ts`
  - Unit tests for precedence, dedup, warnings, and errors.
- `src/extensions/attractor-command.ts`
  - Replace local `resolveWorkflowPath` / `discoverWorkflows` logic with shared module calls.
- `src/extensions/attractor-command.test.ts`
  - Update tests to validate behavior through shared resolver.
- `src/extensions/attractor.ts`
  - Use shared discovery in picker flow.
- `src/cli.ts`
  - Reuse same resolution for `run`, `validate`, and `show` so CLI and extension match.
- `cli.test.ts`
  - Add/adjust tests for bare-name resolution consistency with extension.
- Docs:
  - `README.md`
  - `docs/attractor-extension.md`

## 3) Approach

1. **Define known discovery locations (fixed, no config)**
   - `<cwd>/.attractor/workflows/*.awf.kdl`
   - `<repo-root>/.attractor/workflows/*.awf.kdl` (for invocation from subdirs)
   - `~/.attractor/workflows/*.awf.kdl` (global user-level workflows)

2. **Implement shared API**
   - `discoverWorkflows(cwd): { entries, warnings }`
   - `resolveWorkflowPath(cwd, ref): { path, warnings }` (or throw typed error)
   - Behavior:
     - Existing explicit path (absolute/relative) resolves directly.
     - Bare name resolves against discovered catalog by filename stem.
     - Missing ref reports searched locations.

3. **Deterministic precedence**
   - Project-local (cwd/repo) before global (`~/.attractor/workflows`).
   - Duplicates by filename stem: first by precedence wins.
   - Add warning listing duplicate candidates and chosen path.

4. **Dedup rule**
   - Key: filename stem (`deploy.awf.kdl` → `deploy`).
   - Keep first by precedence, emit warnings for shadowed entries.

5. **Integrate both surfaces**
   - Extension picker uses shared discovery.
   - Extension parser uses shared resolver.
   - CLI `run|validate|show` uses same resolver and warning/error semantics.

6. **No caching**
   - Discover fresh per command invocation.

## 4) Edge cases

- Same filename exists in project + global locations.
- Same filename appears in both cwd and repo-root workflow dirs.
- Invalid KDL files in discovery dirs (skip + warning).
- Missing known dirs (treated as empty).
- CLI run from nested subdir inside repo.
- Bare ref not found anywhere.
- Explicit path provided but file missing.

## 5) Test cases

1. **Discovery**
   - Empty result if no known dirs exist.
   - Only `*.awf.kdl` included.
   - Parse-failing files skipped with warnings.

2. **Dedup/precedence**
   - Project duplicate beats global duplicate.
   - Duplicate filename emits warning with selected + shadowed paths.
   - Stable deterministic order.

3. **Resolution**
   - Existing relative path resolves directly.
   - Existing absolute path resolves directly.
   - Bare name resolves by filename stem with precedence.
   - Missing bare name throws actionable error with searched locations.

4. **Parity**
   - CLI and extension resolve same bare refs to same target paths.

5. **Regression**
   - Existing `.attractor/workflows/<name>.awf.kdl` behavior remains valid.

## 6) Open questions

1. Confirm known location list exactly:
   - `<cwd>/.attractor/workflows`
   - `<repo-root>/.attractor/workflows`
   - `~/.attractor/workflows`
2. For duplicate warnings on successful resolution:
   - Always show, or only in verbose/guided contexts?
3. For explicit-path resolution:
   - Suppress duplicate warnings since user selected exact file?

## Decision log

- **Accepted:** Use only Attractor folders; no `.pi/workflows`.
- **Accepted:** No user-configurable discovery paths in this phase.
- **Accepted:** Deduplication key is filename stem, not internal workflow name.
- **Accepted:** Deterministic precedence with warning when duplicate was resolved.
- **Accepted:** CLI and extension must share one resolver/discovery implementation.
- **Rejected:** Discovery caching for now (added complexity, low immediate value).
