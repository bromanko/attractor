# Attractor — TODO

## Pipeline Engine

- [ ] **Graph composition** — Support including/embedding graphs from other `.dot` files. Enable reusable sub-pipelines (e.g. a shared review pipeline included by multiple feature workflows). Syntax TBD — could be `subgraph` with a `file` attribute or a custom `include` directive.
- [ ] **Workflow search path** — Resolve workflow names from well-known directories so `attractor run my-pipeline` finds `.attractor/workflows/my-pipeline.dot` (repo-local) or `~/.config/attractor/workflows/my-pipeline.dot` (user-global).
- [ ] **Checkpoint resume routing correctness** — On resume, continue from the exact previously selected next node/edge, not just the first outgoing edge from `checkpoint.current_node`. Persist selected edge/next node in `checkpoint.json` and use it during recovery.
- [x] **CLI resume entrypoint** — `attractor run <pipeline.dot> --resume` loads `<logs>/checkpoint.json`, recovers workspace (including tip commit), and resumes execution.

## CLI Output & UX

- [x] **Remove model from startup banner** — The banner displays a single model, but individual stages can override with `llm_model`/`llm_provider`. Either remove the model line or label it "Default model" to avoid confusion.
- [x] **Progress indication for long-running stages** — After `stage_started`, there's no visual feedback until the stage completes. Add a spinner, elapsed timer, or periodic dot/tick output so the user can tell the process isn't frozen.
- [ ] **Running workflow visibility (tmux-based observability)** — Design a way to inspect live workflow execution in real time using `tmux`.
  - [ ] Define UX: `attractor run ... --tmux` or `attractor watch <run-id>` that opens/attaches to a session.
  - [ ] Decide pane layout (e.g. stage timeline, latest logs/events, checkpoint/context summary, selfci output).
  - [ ] Stream structured stage events to pane(s) without breaking non-interactive mode.
  - [ ] Handle reconnect/attach for long-running or detached workflows.
  - [ ] Add graceful fallback when `tmux` is unavailable (plain terminal output unchanged).
- [x] **Fix banner border alignment** — The box-drawing characters in the startup banner are misaligned (content width doesn't match border width). Use consistent column widths for `┌`, `│`, and `└` lines.
- [x] **Show per-stage model** — When a stage uses a non-default model, display it alongside the stage name in the output (e.g., `▶️  plan_review [gpt-5.3-codex]`).
- [x] **Render markdown in terminal output** — LLM responses displayed at human gates and in failure messages are raw markdown. Use `marked` + `marked-terminal` to render headings, lists, code blocks, and emphasis with ANSI formatting for readable terminal output.
- [ ] **Structured failure output for tool stages (esp. `selfci`)** — Replace generic `Command failed` messages with concise, actionable diagnostics.
  - [ ] Persist per-stage logs (`stdout.log`, `stderr.log`, `meta.json`) under run logs.
  - [ ] Capture structured failure fields (command, cwd, exit code/signal, duration, stderr/stdout tail).
  - [ ] Extract and print a one-line "failure digest" for common tools (`selfci`, `tsc`, `vitest`, `nix`) while still linking full logs.
  - [ ] Improve final summary to include failed node, failure class, first failing check, and rerun command.
  - [ ] Distinguish "noise" warnings (e.g. non-fatal SQLite busy) from primary failure causes.
- [ ] **Structured review stage output (`review_code`)** — Review failures are currently dumped as raw markdown blocks in a single line.
  - [ ] Render a compact header (`severity`, `category`, `file:line`, short finding title) with optional expanded details.
  - [ ] Store parsed findings as structured JSON artifact per stage for later summarization/routing.
  - [ ] Add clearer visual treatment for finding blocks (border/background color panel) to separate them from pipeline status lines.
- [ ] **Workflow usage/cost metrics in CLI output** — Show token and cost telemetry (similar to pi status bar) during runs when available, and always summarize at pipeline end.
  - [ ] Track per-stage usage (`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `total_tokens`, `cost`) from backend/context.
  - [ ] Add optional live stage footer or periodic updates for running totals (tokens in/out + estimated cost).
  - [ ] Extend final summary with run totals and a per-stage breakdown table.
  - [ ] Gracefully degrade when usage data is unavailable (show `n/a`, keep summary format stable).

## Trust & Signal Integrity

- [ ] **Prevent LLM self-assessment in fix/implement stages** — LLM stages that make code changes should not self-report success via `[STATUS: success]`. Their output claims ("all tests pass", "addresses all findings") are unreliable. Only verification stages (selfci, reviews) should produce status signals. Consider: (a) stripping `[STATUS:]` markers from non-review nodes, (b) adding a node attribute like `ignore_status_markers=true`, or (c) always treating implement/fix nodes as `success` regardless of markers.
- [ ] **Human review gate re-review after revision** — When an implement/fix stage has a human review gate and the reviewer requests revisions, the pipeline should loop back to the human review after the revision is applied rather than auto-merging. The reviewer must be able to inspect the revised output before it proceeds. This avoids silently accepting changes that may not address the reviewer's concerns.
- [ ] **Review findings accumulation** — When multiple reviews run in sequence and some fail, the `fix` node needs all findings aggregated, not just the last one. Consider a `findings` context key that accumulates across review stages, or have the gate node summarize all review outcomes before routing to fix.

## PiBackend

- [ ] **Opt-in extension/skill loading** — Add config options to `PiBackendConfig` to selectively enable pi extensions, skills, or AGENTS.md discovery for pipeline runs that want it.
- [ ] **Cancellation support** — Wire an `AbortSignal` through `PiBackend.run()` for graceful cancellation of long-running agent sessions.
- [ ] **Event-driven streaming output** — Extend `onStageEvent` to provide structured progress (token counts, tool calls) for real-time UI updates.

## Done

- [x] **Replace custom LLM/Agent layers with pi SDK** — Deleted `src/llm/` and `src/agent/`, replaced `LlmBackend` with `PiBackend` backed by `@mariozechner/pi-coding-agent`. All LLM providers now come from pi's model registry.
