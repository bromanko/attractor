# Attractor

A KDL-based workflow runner that orchestrates multi-stage AI workflows. Each stage is an AI/tool/human task and transitions define execution flow.

Built from the [StrongDM Software Factory](https://factory.strongdm.ai/) NLSpecs:

- [Attractor Specification](https://github.com/strongdm/attractor/blob/main/attractor-spec.md) — Pipeline engine
- [Coding Agent Loop Specification](https://github.com/strongdm/attractor/blob/main/coding-agent-loop-spec.md) — Provider-aligned agentic loop
- [Unified LLM Client Specification](https://github.com/strongdm/attractor/blob/main/unified-llm-spec.md) — Multi-provider LLM SDK

## Architecture

```
┌─────────────────────────────────────────┐
│  CLI                                    │  Standalone CLI entry point
│  (src/cli.ts)                           │  (run, validate, show)
├─────────────────────────────────────────┤
│  Pi Extension                           │  /attractor slash command,
│  (src/extensions/)                      │  TUI panel, interactive interviewer
├─────────────────────────────────────────┤
│  PiBackend                              │  CodergenBackend powered by pi SDK
│  (src/pi-backend.ts)                    │  (AgentSession, tool modes, usage)
├─────────────────────────────────────────┤
│  Pipeline Engine                        │  KDL parser, execution engine,
│  (src/pipeline/)                        │  handlers, conditions, validators
└─────────────────────────────────────────┘
```

## Quick Start

### Define a workflow in KDL syntax

```kdl
workflow "FeaturePipeline" {
  version 2
  goal "Implement and validate a feature"
  start "plan"

  stage "plan" kind="llm" prompt="Plan the implementation for: $goal"
  stage "implement" kind="llm" prompt="Implement the plan" goal_gate=true
  stage "validate" kind="llm" prompt="Run tests and verify correctness"

  stage "gate" kind="decision" {
    route when="outcome(\"validate\") == \"success\"" to="exit"
    route when="true" to="implement"
  }

  stage "exit" kind="exit"

  transition from="plan" to="implement"
  transition from="implement" to="validate"
  transition from="validate" to="gate"
}
```

### Run the pipeline

```ts
import { parseWorkflowKdl, workflowToGraph, validateWorkflowOrRaise, runPipeline } from "attractor";

const kdl = fs.readFileSync("pipeline.awf.kdl", "utf-8");
const workflow = parseWorkflowKdl(kdl);
validateWorkflowOrRaise(workflow);
const graph = workflowToGraph(workflow);

const result = await runPipeline({
  graph,
  logsRoot: "./logs",
  backend: myCodergenBackend,  // Your LLM integration
  onEvent: (event) => console.log(event.kind, event.data),
});
```

## Pipeline Engine Features

### Stage Kinds

| Kind | Handler | Description |
|------|---------|-------------|
| `llm` | `codergen` | LLM task with `$goal` variable expansion |
| `exit` | `exit` | Pipeline exit point (no-op, goal gate check) |
| `human` | `wait.human` | Human-in-the-loop gate |
| `decision` | `conditional` | Routing based on edge conditions |
| `tool` | `tool` | External tool execution |
| `workspace.create` | `workspace.create` | Create an isolated jj workspace |
| `workspace.merge` | `workspace.merge` | Merge a workspace back |
| `workspace.cleanup` | `workspace.cleanup` | Clean up a workspace |

### Edge Selection

5-step deterministic priority: condition match → preferred label → suggested IDs → weight → lexical tiebreak.

### Condition Expressions

```kdl
stage "gate" kind="decision" {
  route when="outcome(\"validate\") == \"success\"" to="deploy"
  route when="outcome(\"validate\") == \"fail\"" to="fix"
  route when="outcome(\"validate\") == \"success\" && context(\"tests_passed\") == \"true\"" to="deploy"
}
```

### Goal Gates

Stages with `goal_gate=true` must succeed before the pipeline can exit.

### Model Profiles

KDL workflows configure per-stage models via named profiles:

```kdl
workflow "example" {
  version 2
  start "plan"

  models {
    default "fast"
    profile "fast" model="claude-sonnet-4-5"
    profile "heavy" model="claude-opus-4-6" reasoning_effort="high"
  }

  stage "plan" kind="llm" prompt="Plan it" model_profile="fast"
  stage "implement" kind="llm" prompt="Build it" model_profile="heavy"
  stage "done" kind="exit"

  transition from="plan" to="implement"
  transition from="implement" to="done"
}
```


### Checkpoint & Resume

Execution state saved after each node. Resume from any checkpoint.

### Human-in-the-Loop

Built-in interviewers: `AutoApproveInterviewer`, `QueueInterviewer`, `CallbackInterviewer`, `RecordingInterviewer`.

## Project Structure

```
src/
├── cli.ts                  Standalone CLI entry point
├── cli-renderer.ts         CLI output rendering
├── pi-backend.ts           CodergenBackend powered by pi SDK
├── interactive-interviewer.ts  Interactive human gate prompts
├── index.ts                Public API re-exports
├── pipeline/               Pipeline Engine
│   ├── types.ts            Graph model, context, handlers, interviewers
│   ├── workflow-types.ts   KDL workflow definition types
│   ├── workflow-kdl-parser.ts  KDL workflow parser
│   ├── workflow-loader.ts  Workflow-to-graph conversion
│   ├── workflow-validator.ts   Workflow-level validation
│   ├── workflow-expr.ts    Workflow expression evaluator
│   ├── validator.ts        Graph-level lint rules
│   ├── conditions.ts       Edge condition expression language
│   ├── engine.ts           Core execution loop, edge selection, checkpoints
│   ├── handlers.ts         Node handlers + registry
│   ├── interviewers.ts     Human-in-the-loop implementations
│   ├── workspace.ts        Jujutsu workspace handlers
│   ├── tool-failure.ts     Structured tool failure details
│   ├── status-markers.ts   Stage status file utilities
│   └── graph-to-dot.ts     Graph → DOT export
└── extensions/             Pi extension integration
    ├── attractor.ts        Main extension entry point
    ├── attractor-command.ts   Pipeline CLI commands
    ├── attractor-interviewer.ts  Interactive interviewer
    └── attractor-panel.ts  TUI panel rendering
```

## CLI

Attractor ships a standalone CLI for running, validating, and visualizing workflows.

```sh
npm install -g attractor   # or use npx attractor
```

### Commands

```sh
# Run a pipeline
attractor run pipeline.awf.kdl [options]

# Validate a workflow graph
attractor validate pipeline.awf.kdl

# Visualize a workflow graph (ASCII/boxart via graph-easy, or raw DOT)
attractor show pipeline.awf.kdl [--format ascii|boxart|dot]

# List available LLM models
attractor list-models [--provider anthropic]
```

### Run Options

| Flag | Description |
|------|-------------|
| `--goal <text>` | Override the graph's goal attribute |
| `--model <model>` | LLM model to use (default: `claude-opus-4-6`) |
| `--provider <name>` | Provider name (default: `anthropic`) |
| `--logs <dir>` | Logs directory (default: `.attractor/logs`) |
| `--system <prompt>` | System prompt for codergen stages |
| `--tools <mode>` | Tool mode: `none`, `read-only`, `coding` (default: `coding`) |
| `--approve-all` | Auto-approve all human gates (no interactive prompts) |
| `--resume [checkpoint]` | Resume from checkpoint (default: `<logs>/checkpoint.json`) |
| `--dry-run` | Validate and print graph without executing |
| `--verbose` | Show detailed event output |

### Authentication

The CLI uses pi's `AuthStorage` for credentials. Either:

- Set `ANTHROPIC_API_KEY` in your environment, or
- Run `pi /login` to authenticate with a Claude subscription

### Example

```sh
attractor run feature.awf.kdl --goal "Add user authentication" --tools coding --verbose
```

The CLI renders a live spinner per stage, shows per-stage model overrides, and prints a usage/cost summary at completion.

## Pi Extension

Attractor integrates with the [pi coding agent](https://github.com/mariozechner/pi-coding-agent) as a `/attractor` slash command, providing an interactive TUI experience for pipeline execution.

### Setup

Place the extension entry point in your project:

```
.pi/extensions/attractor.ts
```

```ts
// Re-exports the built attractor extension for pi auto-discovery
export { default } from "../../dist/extensions/attractor.js";
```

Then reload pi (`/reload`) to pick up the extension.

### Commands

```
/attractor run <workflow> --goal "..." [options]
/attractor validate <workflow>
/attractor show <workflow> [--format ascii|boxart|dot]
```

### Workflow Resolution

The extension resolves workflow references in order:

1. Direct file path (absolute or relative to cwd)
2. Bare name → `.attractor/workflows/<name>.awf.kdl`

So `/attractor run deploy` will look for `.attractor/workflows/deploy.awf.kdl`.

### Run Options

| Flag | Description |
|------|-------------|
| `--goal <text>` | Pipeline goal (required unless the graph has one) |
| `--resume` | Resume from last checkpoint |
| `--approve-all` | Auto-approve all human gates |
| `--logs <dir>` | Logs directory (default: `.attractor/logs`) |
| `--tools <mode>` | Tool mode: `none`, `read-only`, `coding` |
| `--dry-run` | Validate and print graph without executing |

### Features

- **Interactive interviewer** — human gate prompts appear inline in the pi TUI
- **Live panel** — stage progress, agent tool calls, and text streaming rendered via custom message types
- **Stage result rendering** — success/failure cards with elapsed time and error details in the conversation area
- **Tab completion** — subcommand suggestions when typing `/attractor`

## Development

This repo is managed with **Nix flakes**. Enter the dev shell first:

```sh
nix develop        # or use direnv (auto-loads .envrc)
```

Then:

```sh
npm install
npm run build
npm run lint       # type-check
npm test
```
