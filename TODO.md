# Attractor — TODO

## Pipeline Engine

- [ ] **Parallel execution (v1 correctness hardening)** — Parallel fork/join landed, but review found merge-blocking correctness gaps that must be fixed before considering this done.
  - [ ] **Fix branch fail-path semantics in `executeBranch()` (`src/pipeline/engine.ts`)**
    - Current bug: branch returns terminal failure immediately when a node outcome is `fail`, skipping normal edge selection.
    - Required behavior: preserve main-loop semantics inside branches — apply context updates, evaluate/select next edge, and continue if a valid failure route exists.
    - Only terminally fail a branch when there is no valid next edge/retry path (or explicit policy forbids continuation).
    - Add tests:
      - branch node returns `fail` but has failure-handling edge that reaches join (should succeed overall)
      - branch node returns `fail` with no routable edge (should fail)
  - [ ] **Disallow nested parallel regions in v1 (`src/pipeline/validator.ts`)**
    - Current bug: comments say nested parallel unsupported, but validator does not enforce this.
    - Add explicit validation error when a branch subtree contains another `parallel` fork before reaching the resolved join.
    - Error should include outer fork id + nested fork id for debuggability.
  - [ ] **Add defensive runtime guard for nested forks in branch runner (`src/pipeline/engine.ts`)**
    - If validation is bypassed and `executeBranch()` encounters `parallel`, fail loudly instead of executing it as a normal stage.
    - Emit clear error event/message indicating nested parallel is unsupported in v1.
  - [ ] **Fix `completed_nodes` accuracy after parallel blocks (`src/pipeline/engine.ts`)**
    - Current bug: post-parallel reconstruction replays paths using final branch outcome, which can mis-mark nodes.
    - Track canonical per-branch executed node IDs during real execution and return them in `BranchResult`.
    - Merge these exact node IDs into checkpoint/state instead of synthetic replay.
    - Add tests where branch routing depends on intermediate outcomes to verify completed node list is exact.
  - [ ] **Regression/contract tests for parallel correctness**
    - Ensure non-parallel pipelines are unchanged.
    - Ensure deterministic ordering/log metadata still holds after fixes.
    - Ensure selfci test/lint/build stays green with these fixes.
- [ ] **Graph composition** — Support including/embedding graphs from other `.dot` files. Enable reusable sub-pipelines (e.g. a shared review pipeline included by multiple feature workflows). Syntax TBD — could be `subgraph` with a `file` attribute or a custom `include` directive.
- [ ] **Workflow search path** — Resolve workflow names from well-known directories so `attractor run my-pipeline` finds `.attractor/workflows/my-pipeline.dot` (repo-local) or `~/.config/attractor/workflows/my-pipeline.dot` (user-global).
- [ ] **Checkpoint resume routing correctness** — On resume, continue from the exact previously selected next node/edge, not just the first outgoing edge from `checkpoint.current_node`. Persist selected edge/next node in `checkpoint.json` and use it during recovery.
- [x] **CLI resume entrypoint** — `attractor run <pipeline.dot> --resume` loads `<logs>/checkpoint.json`, recovers workspace (including tip commit), and resumes execution.

## CLI Output & UX

- [ ] **Remove model from startup banner** — The banner displays a single model, but individual stages can override with `llm_model`/`llm_provider`. Either remove the model line or label it "Default model" to avoid confusion.
- [ ] **Progress indication for long-running stages** — After `stage_started`, there's no visual feedback until the stage completes. Add a spinner, elapsed timer, or periodic dot/tick output so the user can tell the process isn't frozen.
- [ ] **Running workflow visibility (tmux-based observability)** — Design a way to inspect live workflow execution in real time using `tmux`.
  - [ ] Define UX: `attractor run ... --tmux` or `attractor watch <run-id>` that opens/attaches to a session.
  - [ ] Decide pane layout (e.g. stage timeline, latest logs/events, checkpoint/context summary, selfci output).
  - [ ] Stream structured stage events to pane(s) without breaking non-interactive mode.
  - [ ] Handle reconnect/attach for long-running or detached workflows.
  - [ ] Add graceful fallback when `tmux` is unavailable (plain terminal output unchanged).
- [ ] **Fix banner border alignment** — The box-drawing characters in the startup banner are misaligned (content width doesn't match border width). Use consistent column widths for `┌`, `│`, and `└` lines.
- [ ] **Show per-stage model** — When a stage uses a non-default model, display it alongside the stage name in the output (e.g., `▶️  plan_review [gpt-5.3-codex]`).
- [ ] **Render markdown in terminal output** — LLM responses displayed at human gates and in failure messages are raw markdown. Use `marked` + `marked-terminal` to render headings, lists, code blocks, and emphasis with ANSI formatting for readable terminal output.

## Trust & Signal Integrity

- [ ] **Prevent LLM self-assessment in fix/implement stages** — LLM stages that make code changes should not self-report success via `[STATUS: success]`. Their output claims ("all tests pass", "addresses all findings") are unreliable. Only verification stages (selfci, reviews) should produce status signals. Consider: (a) stripping `[STATUS:]` markers from non-review nodes, (b) adding a node attribute like `ignore_status_markers=true`, or (c) always treating implement/fix nodes as `success` regardless of markers.
- [ ] **Review findings accumulation** — When multiple reviews run in sequence and some fail, the `fix` node needs all findings aggregated, not just the last one. Consider a `findings` context key that accumulates across review stages, or have the gate node summarize all review outcomes before routing to fix.

## PiBackend

- [ ] **Opt-in extension/skill loading** — Add config options to `PiBackendConfig` to selectively enable pi extensions, skills, or AGENTS.md discovery for pipeline runs that want it.
- [ ] **Cancellation support** — Wire an `AbortSignal` through `PiBackend.run()` for graceful cancellation of long-running agent sessions.
- [ ] **Event-driven streaming output** — Extend `onStageEvent` to provide structured progress (token counts, tool calls) for real-time UI updates.

## Done

- [x] **Replace custom LLM/Agent layers with pi SDK** — Deleted `src/llm/` and `src/agent/`, replaced `LlmBackend` with `PiBackend` backed by `@mariozechner/pi-coding-agent`. All LLM providers now come from pi's model registry.
