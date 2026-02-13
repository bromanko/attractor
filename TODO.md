# Attractor — TODO

## Pipeline Engine

- [ ] **Graph composition** — Support including/embedding graphs from other `.dot` files. Enable reusable sub-pipelines (e.g. a shared review pipeline included by multiple feature workflows). Syntax TBD — could be `subgraph` with a `file` attribute or a custom `include` directive.
- [ ] **Workflow search path** — Resolve workflow names from well-known directories so `attractor run my-pipeline` finds `.attractor/workflows/my-pipeline.dot` (repo-local) or `~/.config/attractor/workflows/my-pipeline.dot` (user-global).
- [ ] **Checkpoint resume routing correctness** — On resume, continue from the exact previously selected next node/edge, not just the first outgoing edge from `checkpoint.current_node`. Persist selected edge/next node in `checkpoint.json` and use it during recovery.
- [x] **CLI resume entrypoint** — `attractor run <pipeline.dot> --resume` loads `<logs>/checkpoint.json`, recovers workspace (including tip commit), and resumes execution.

## CLI Output & UX

- [x] **Remove model from startup banner** — The banner displays a single model, but individual stages can override with `llm_model`/`llm_provider`. Either remove the model line or label it "Default model" to avoid confusion.
- [x] **Progress indication for long-running stages** — After `stage_started`, there's no visual feedback until the stage completes. Add a spinner, elapsed timer, or periodic dot/tick output so the user can tell the process isn't frozen.
- [x] **Fix banner border alignment** — The box-drawing characters in the startup banner are misaligned (content width doesn't match border width). Use consistent column widths for `┌`, `│`, and `└` lines.
- [x] **Show per-stage model** — When a stage uses a non-default model, display it alongside the stage name in the output (e.g., `▶️  plan_review [gpt-5.3-codex]`).
- [x] **Render markdown in terminal output** — LLM responses displayed at human gates and in failure messages are raw markdown. Use `marked` + `marked-terminal` to render headings, lists, code blocks, and emphasis with ANSI formatting for readable terminal output.
- [x] **Structured failure output for tool stages (esp. `selfci`)** — Per-stage logs (`stdout.log`, `stderr.log`, `meta.json`), structured failure fields, failure digest extraction for common tools, final summary with failure class/digest/rerun command.
- [x] **Structured review stage output (`review_code`)** — Severity-based diagnostics with structured rendering via pi extensions and validator.
- [x] **Workflow usage/cost metrics in CLI output** — Per-stage usage tracking (input/output/cache tokens + cost), `usage_update` events, final summary with per-stage breakdown table, graceful degradation when unavailable.

## Trust & Signal Integrity

- [x] **Prevent LLM self-assessment in fix/implement stages** — Codergen nodes (shape `box`) now ignore `[STATUS:]` markers by default. Review/verification nodes opt in with `auto_status=true`. Routing markers (`PREFERRED_LABEL`, `NEXT`) are always parsed.
- [x] **Human review gate re-review after revision** — When an implement/fix stage has a human review gate and the reviewer requests revisions, the pipeline should loop back to the human review after the revision is applied rather than auto-merging. The reviewer must be able to inspect the revised output before it proceeds. This avoids silently accepting changes that may not address the reviewer's concerns.
- [ ] **Review findings accumulation** — When multiple reviews run in sequence and some fail, the `fix` node needs all findings aggregated, not just the last one. Consider a `findings` context key that accumulates across review stages, or have the gate node summarize all review outcomes before routing to fix.

## Done

- [x] **Cancellation support** — Wire an `AbortSignal` through `PiBackend.run()` for graceful cancellation of long-running agent sessions.
- [x] **Replace custom LLM/Agent layers with pi SDK** — Deleted `src/llm/` and `src/agent/`, replaced `LlmBackend` with `PiBackend` backed by `@mariozechner/pi-coding-agent`. All LLM providers now come from pi's model registry.
