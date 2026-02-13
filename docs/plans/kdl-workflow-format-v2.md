---
title: KDL Workflow Format v2 (AWF2) — Specification and Implementation Plan
date: 2026-02-13
goal: Replace DOT workflows with a KDL-based workflow format that is explicit, validated, and author-friendly
status: proposed
---

# KDL Workflow Format v2 (AWF2)

## Summary

This plan replaces DOT workflow authoring with KDL.

Why:
- DOT is great for diagrams, but weak as a runtime-authoring format.
- Current semantics are too implicit (shape/type coupling, fallback routing, stringly attrs).
- KDL is structured, readable, non-whitespace-significant, and less noisy than JSON.

Decisions locked in this revision:
- **No backward compatibility required.**
- **KDL is the source of truth.**
- **File extension: `.awf.kdl`.**
- **DOT exporter deferred out of scope.**

---

## Goals

1. Make workflow behavior explicit and deterministic.
2. Eliminate shape-based semantic magic.
3. Provide strict validation and actionable diagnostics.
4. Keep stage-level runtime capabilities (llm/tool/human/decision/workspace).
5. Improve readability and PR diff quality.

## Non-goals

1. Supporting legacy DOT authoring.
2. Building a general-purpose programming language.
3. Building DOT export/visualization in v2.

---

## Format Overview

- Extension: `.awf.kdl`
- Root node: `workflow`
- Required top-level: `version`, `start`, `stage ...`
- Stage behavior is explicit via `kind`
- Routing is explicit and partitioned by stage kind (see below)

### Routing partition (hard rule)

To remove ambiguity:
- **`human` and `decision` stages use only stage-local routing** (`option` / `route`).
- **All other stage kinds use only global `transition` entries.**
- Validator error if both mechanisms are used for the same source stage.

This removes any “which wins?” ambiguity.

### Example

```kdl
workflow "feature_dev" {
  version 2
  goal "Implement and validate feature X"
  start "plan"

  models {
    default "claude-sonnet-4-5"
    profile "review" model="claude-opus-4-6" reasoning_effort="high"
  }

  stage "plan" kind="llm" prompt_file="prompts/plan.md"

  stage "human_review" kind="human" {
    prompt "Review the plan"
    option "approve" label="Approve" to="implement"
    option "revise"  label="Revise"  to="revise_plan"
    require_feedback_on "revise"
    re_review true
  }

  stage "revise_plan" kind="llm" prompt_file="prompts/revise_plan.md" model_profile="review"
  stage "implement"   kind="llm" prompt_file="prompts/implement.md" goal_gate=true
  stage "selfci"      kind="tool" command="nix develop -c selfci"

  stage "gate" kind="decision" {
    route when="outcome(\"selfci\") == \"success\"" to="merge"
    route when="true" to="fix"
  }

  stage "fix" kind="llm" prompt_file="prompts/fix.md" {
    retry max_attempts=2 backoff="exponential" delay="500ms" max_delay="30s"
  }

  stage "merge" kind="workspace.merge"
  stage "exit"  kind="exit"

  transition from="plan" to="human_review"
  transition from="revise_plan" to="human_review"
  transition from="implement" to="selfci"

  // explicit failure routing for tool stage
  transition from="selfci" to="gate" when="outcome(\"selfci\") == \"success\""
  transition from="selfci" to="fix"  when="outcome(\"selfci\") == \"fail\""

  transition from="fix" to="selfci"
  transition from="merge" to="exit"
}
```

---

## AWF2 Specification (Draft)

## 1) Top-level structure

`workflow <name> { ... }`

Allowed child nodes:
- `version <int>` (required; must be `2`)
- `goal <string>` (optional)
- `start <stage_id>` (required)
- `settings { ... }` (optional)
- `models { ... }` (optional)
- `stage <id> kind="..." ... { ... }` (required; at least one)
- `transition from="..." to="..." [when="..."] [priority=<int>]` (optional)

## 2) Stage kinds

Supported kinds:
- `exit`
- `llm`
- `tool`
- `human`
- `decision`
- `workspace.create`
- `workspace.merge`
- `workspace.cleanup`

**Note:** `start` is **not** a stage kind in AWF2. Entry point is defined only by top-level `start`.

### 2.1 `llm`
Required:
- exactly one of `prompt` or `prompt_file`

Optional:
- `model`, `provider`, `model_profile`, `reasoning_effort`
- `auto_status` (bool)
- `goal_gate` (bool)
- `response_key_base` (string)
- `retry` child node
- `meta` child node (extension-specific data)

### 2.2 `tool`
Required:
- `command`

Optional:
- `cwd`
- `timeout` (duration string)
- `retry` child node
- `meta` child node

### 2.3 `human`
Required:
- `prompt`
- at least two `option` entries

`option` shape:
- `option <key> label="..." to="<stage_id>"`

Optional:
- `require_feedback_on <option_key>` (repeatable)
- `details_from "k1,k2,..."`
- `re_review` (bool, default true)
- `meta` child node

Known v2 limitation:
- `option` is both UI choice and route target.
- Conditional routing *inside a single option* is not supported in v2; defer to v3.

### 2.4 `decision`
Required:
- one or more `route` entries

`route` shape:
- `route when="<expr>" to="<stage_id>" [priority=<int>]`

Rule:
- Must include catch-all route `when="true"`.
- Missing catch-all is a **validation error**.

### 2.5 `workspace.*`
Maps directly to existing workspace handlers, with kind-specific attrs as needed.

### 2.6 Model resolution semantics

Resolution precedence (highest to lowest):
1. stage `model` / `provider` / `reasoning_effort`
2. `model_profile` referenced in `models.profile`
3. `models.default` (and optional default provider, if defined)
4. runtime CLI defaults

Validator errors:
- unknown `model_profile`

## 3) Retry policy

Retry is a **child node**, not inline stage attrs.

Canonical shape:
- `retry max_attempts=<int> backoff="none|fixed|exponential" delay="500ms" max_delay="30s"`

Defaults:
- no implicit retry if `retry` is absent

## 4) Transitions and routing

### 4.1 Global transitions

For non-`human`/`decision` stages:
- `transition from="<stage_id>" to="<stage_id>" [when="<expr>"] [priority=<int>]`

Selection:
1. evaluate `when` (default true)
2. keep matches
3. highest `priority`
4. declaration order tie-break
5. no match => runtime failure

### 4.2 Stage-local routing

- `human`: `option ... to="..."`
- `decision`: `route ... to="..."`

Validator rejects:
- `transition from="human_or_decision_stage" ...`

## 5) Failure semantics (explicit)

- Stage failure is represented as `outcome("stage") == "fail"`.
- Routing on failure must be explicit via `when` conditions (global transitions or decision routes).
- If a stage fails and no route/transition matches, pipeline fails immediately with a clear error.
- No implicit “forward failure to gate” behavior.

## 6) Expression language (`when`)

Grammar:
- `==`, `!=`
- `&&`, `||`, `!`
- parentheses
- literals: string, number, boolean
- functions:
  - `outcome("stage_id")`
  - `output("stage_id.key")`
  - `exists("stage_id.key")`

### 6.1 Scoping and missing-value rules

- Unknown `stage_id` in expressions: validation error.
- `outcome("stage_id")` returns one of:
  - `success`, `fail`, `partial_success`, `retry`, `cancelled`, `not_run`
- `output("stage_id.key")`:
  - returns typed value if present
  - returns `null` if stage not run or key absent
- `exists("stage_id.key")`:
  - true only if stage ran and key exists

No bare-key lookups; no implicit global fallback.

## 7) Context/output model

All stage writes are namespaced under stage ID:
- `stage_id.status`
- `stage_id.response`
- `stage_id.error`
- `stage_id.*` custom outputs

Reserved globals:
- `graph.goal`
- `graph.name`

## 8) Validation rules (error-level)

1. missing required top-level fields.
2. duplicate stage IDs.
3. unknown stage kind.
4. unknown attrs for kind.
5. `start` references missing stage.
6. no reachable `exit` from `start`.
7. unreachable stages.
8. transition from/to references missing stage.
9. malformed expressions.
10. expression references unknown stage IDs.
11. human stage has <2 options.
12. decision stage missing catch-all route.
13. retry policy invalid values/durations.
14. routing mechanism mixing violations (partition rule).
15. disallowed core UI materialization attrs; those must live in `meta`.

## 9) Metadata extension point

Core AWF2 excludes UI-specific draft-plan fields.
Use:
- `meta { ... }` under stage for extension-specific behavior.

Example:
```kdl
stage "human_review" kind="human" {
  prompt "Review"
  option "approve" label="Approve" to="next"
  option "revise" label="Revise" to="revise"
  meta {
    draft_path "docs/plans/<slug>.draft.md"
    draft_context_key "plan.response"
  }
}
```

---

## Implementation Plan

## Phase 0 — Semantics freeze (must complete before coding)

1. Approve this spec revision.
2. Lock extension to `.awf.kdl`.
3. Lock routing partition rule.
4. Lock failure semantics (explicit only; no implicit forwarding).
5. Lock expression scoping and missing-value behavior.
6. Lock model resolution precedence.

Deliverable: frozen spec checklist signed off in review.

## Phase 1 — Parser + normalization + routing bridge

Create:
- `src/pipeline/awf2-types.ts`
- `src/pipeline/awf2-kdl-parser.ts`
- `src/pipeline/awf2-normalize.ts`

Tasks:
1. Parse KDL into AWF2 typed model.
2. Normalize stage-local routes + transitions into one internal routing table.
3. Build runtime IR adapter for engine consumption.

Deliverable: AWF2 files parse and normalize deterministically.

## Phase 2 — Validator and expression engine

Create:
- `src/pipeline/awf2-validator.ts`
- `src/pipeline/awf2-expr.ts`
- tests for both

Tasks:
1. Structural and kind-specific validation rules.
2. Enforce routing partition rule.
3. Enforce catch-all decision route.
4. Implement expression parser/evaluator with typed null/not_run semantics.
5. Emit source-located diagnostics.

Deliverable: `validateAwf2OrRaise()`.

## Phase 3 — Engine changes for explicit semantics

Target:
- `src/pipeline/engine.ts`
- `src/pipeline/handlers.ts`

Tasks:
1. Route using normalized explicit routing table only.
2. Remove shape-driven behavior for AWF2 runs.
3. Implement explicit failed-stage route resolution.
4. Keep cancellation/checkpoint behavior unchanged.

Deliverable: explicit runtime behavior parity with AWF2 rules.

## Phase 4 — CLI + extension integration

Target:
- `src/cli.ts`
- `src/extensions/attractor.ts`

Tasks:
1. Resolve `.awf.kdl` workflows.
2. `validate` and `run` on AWF2.
3. Add `--explain-routing` output for chosen route + condition trace.

Deliverable: AWF2-first CLI + extension UX.

## Phase 5 — Workflow/test migration

Tasks:
1. Rewrite `.attractor/workflows/*.dot` to `.awf.kdl`.
2. Rewrite `examples/*.dot` and integration fixtures.
3. Remove DOT parser/tests after parity is complete.

Deliverable: repository fully AWF2.

## Phase 6 — Docs

Tasks:
1. Add `docs/workflow-format-awf2.md` (authoring spec + cookbook).
2. Update README and extension docs.
3. Add troubleshooting section for validation and routing errors.

Deliverable: complete v2 docs.

---

## Proposed File Changes (initial)

Add:
- `src/pipeline/awf2-types.ts`
- `src/pipeline/awf2-kdl-parser.ts`
- `src/pipeline/awf2-normalize.ts`
- `src/pipeline/awf2-expr.ts`
- `src/pipeline/awf2-validator.ts`
- `src/pipeline/awf2-loader.ts`
- `docs/workflow-format-awf2.md`

Modify:
- `src/pipeline/index.ts`
- `src/pipeline/engine.ts`
- `src/pipeline/handlers.ts`
- `src/cli.ts`
- `src/extensions/attractor.ts`
- workflow fixtures/tests/docs

Remove (end-state):
- `src/pipeline/dot-parser.ts`
- DOT fixtures/tests/examples

---

## Test Strategy

1. Unit tests
   - KDL parse/normalize
   - expression parsing/evaluation (including `not_run`/`null` behavior)
   - validator rules including routing partition
2. Integration tests
   - deterministic routing and failure routing
   - human/decision stage behavior
   - retries, checkpoint/resume, cancellation
   - workspace lifecycle
3. Golden diagnostics tests
   - stable, actionable error output for common author mistakes

---

## Risks and Mitigations

1. KDL parser ecosystem mismatch
   - isolate dependency behind parser module.
2. Semantics drift during migration
   - migration in small steps with parity tests.
3. Over-strict validation blocks authors
   - allow non-critical warnings only where explicitly justified.

---

## Acceptance Criteria

1. All workflows run from `.awf.kdl` only.
2. Routing ambiguity eliminated by partition rule.
3. Failure routing is fully explicit and documented.
4. Missing decision catch-all is validation error.
5. `attractor validate` diagnostics are source-located and actionable.
6. Existing behavior (reviews, fix loops, cancellation, workspace lifecycle) is preserved under AWF2.

---

## Review Notes Applied in This Revision

1. Resolved dual routing ambiguity via strict partition by stage kind.
2. Kept human option simplicity; recorded v2 limitation for conditional option routing.
3. Defined expression scoping and missing-value behavior (`not_run`, `null`).
4. Removed `start` as a stage kind; top-level `start` only.
5. Clarified retry as a child node syntax.
6. Added explicit failure routing semantics.
7. Moved key semantic decisions into Phase 0 freeze.
8. Added explicit model precedence rules.
9. Chose `.awf.kdl` extension.
10. Moved draft-plan concerns to extension metadata (`meta { ... }`).
11. Set decision catch-all to error.
12. Deferred DOT exporter out of v2 scope.
