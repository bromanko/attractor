## 1) Summary

Revise `/attractor run` (and `validate`) into guided, user-friendly flows in pi, with:

- **Workflow picker/autocomplete** sourced from `.attractor/workflows` (for now)
- **Friendly workflow preview** (name + new schema `description` + key metadata)
- **Required goal capture as a standalone step for fresh runs**
- **Resume-aware behavior**: when `--resume` is used, do **not** prompt for goal and do **not** allow overriding checkpoint goal

Additionally:

- Add **first-class `description`** to workflow schema/parser/types
- Do **not** support `--goal` as a CLI argument in this UX revision

Execution semantics after setup should remain unchanged.

---

## 2) Files to change

- `src/extensions/attractor.ts`
  - Add guided workflow selection for `run` and `validate`
  - Add required goal step for non-resume `run`
  - Block goal override when resuming
  - Improve friendly workflow presentation prior to execution
  - Keep workflow discovery limited to `.attractor/workflows` for now

- `src/extensions/attractor-command.ts`
  - Remove/avoid `--goal` support in parser/completions
  - Support guided mode when workflow arg is omitted (for `run` and `validate`)
  - Add partial-parse helpers for better autocomplete behavior

- `src/extensions/attractor-command.test.ts`
  - Update parser tests for no-`--goal` behavior
  - Add partial-input/autocomplete tests for `run`/`validate`

- `src/extensions/attractor.test.ts`
  - Add extension-level tests for workflow picker + goal step (`run`)
  - Add tests that `validate` gets workflow picker treatment
  - Add resume test: no goal prompt, no goal override path

- `src/pipeline/workflow-types.ts`
  - Add `description` field to workflow type model

- `src/pipeline/workflow-kdl-parser.ts`
  - Parse `description` from workflow root schema

- `src/pipeline/workflow-kdl-parser.test.ts`
  - Add coverage for `description` parsing and compatibility expectations

- `docs/attractor-extension.md`
  - Document guided `run`/`validate`, required-goal step, resume behavior, and workflow description field usage

---

## 3) Approach

1. **Add workflow `description` as schema field**
   - Extend workflow model + parser to recognize root-level `description "..."`
   - Keep existing workflows working (if description omitted, treat as empty/undefined)
   - Ensure surfaced metadata uses `description` when present

2. **Workflow catalog for extension UX (scoped)**
   - Discover workflows from `.attractor/workflows/*.awf.kdl` only
   - Parse each workflow for display metadata: workflow name, `description`, path, stage count
   - Build stable, sorted picker/autocomplete entries

3. **Command parsing/completion updates**
   - Keep core subcommands (`run`, `validate`, `show`)
   - For `run`/`validate`, support missing workflow arg and invoke guided selection
   - Remove `--goal` option from parsing/help/completions
   - Continue contextual completion for workflow names and relevant flags

4. **Guided flow: `run`**
   - If workflow missing: prompt with select menu
   - If not resuming:
     - prompt for goal as a dedicated required step
     - reject empty/whitespace goal with reprompt or clean cancel
   - If resuming:
     - skip goal prompt
     - disallow goal override path
   - Show friendly workflow summary (name, description, path, stage info)
   - Continue existing run execution/panel flow unchanged

5. **Guided flow: `validate`**
   - If workflow missing: prompt with same workflow picker
   - Show friendly workflow metadata before/with validate output
   - Validation logic remains unchanged

6. **Docs + polish**
   - Update extension docs and examples of new interaction model
   - Note current workflow discovery scope (`.attractor/workflows` only) and future TODO

---

## 4) Edge cases

- No workflows found in `.attractor/workflows`
- One or more workflow files fail parse during listing (skip with warning, keep picker usable)
- User cancels workflow picker (`run`/`validate` exit cleanly)
- User cancels goal input in non-resume `run`
- Empty goal input in non-resume `run`
- `run --resume ...` should not request goal and should not accept any goal override path
- Workflows without `description` still parse and display gracefully
- Large workflow set performance (avoid reparsing excessively on each keystroke)

---

## 5) Test cases

- **Parser/args**
  - `--goal` is rejected/unsupported
  - `run` and `validate` can proceed to guided selection when workflow is omitted

- **Autocomplete**
  - `""` → subcommands suggested
  - `"run "` / `"validate "` → workflow suggestions from `.attractor/workflows`
  - partial workflow names filter correctly

- **Guided run**
  - `run` with no workflow opens picker
  - picker cancel exits without side effects
  - non-resume run always asks for goal
  - empty goal is rejected/reprompted
  - resume run skips goal prompt

- **Resume constraints**
  - goal cannot be overridden in resume path
  - resumed run uses checkpoint goal semantics unchanged

- **Guided validate**
  - `validate` with no workflow opens picker and validates selected workflow

- **Workflow description schema**
  - parser accepts workflows with `description`
  - workflows without `description` remain valid
  - extension preview prefers `description` when present

---

## 6) Open questions

1. Should `description` be optional at schema level long-term, or become required in a later migration?
2. For parse failures in picker catalog, should warnings be ephemeral UI messages or logged diagnostics only?
3. Should `show` also adopt workflow picker parity now, or defer to a follow-up?
4. Should workflow catalog metadata be cached for session performance, and with what invalidation strategy?