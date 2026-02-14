# Attractor Pi Extension

Run and validate Attractor KDL-based AI workflows directly inside [pi](https://github.com/badlogic/pi-mono), the CLI coding agent.

## Install

```bash
pi install /path/to/attractor
# or
pi install npm:attractor
```

Or try without installing:

```bash
pi -e /path/to/attractor
```

## Commands

### `/attractor run`

Execute a pipeline with interactive human gates and a rich TUI progress panel.

```
/attractor run [<workflow>] [options]
```

When `<workflow>` is omitted, an interactive picker lists all workflows discovered from `.attractor/workflows/`. Each entry shows the workflow name, description (if present), and stage count.

**Goal prompt:** For non-resume runs, if the workflow does not define a `goal` in its KDL file, you will be prompted to enter one interactively. Empty goals are rejected with a reprompt. Press Escape to cancel.

**Resume behavior:** When `--resume` is used, the goal prompt is skipped entirely. The checkpoint's original goal is preserved and cannot be overridden.

**Arguments:**

| Argument | Description |
|----------|-------------|
| `[<workflow>]` | Path to `.awf.kdl` file, bare name from `.attractor/workflows/`, or omit for interactive picker |
| `--resume` | Resume from last checkpoint (`<logs>/checkpoint.json`) |
| `--approve-all` | Auto-approve all human gates (no interactive prompts) |
| `--logs <dir>` | Logs directory (default: `.attractor/logs`) |
| `--tools <mode>` | Tool mode: `none`, `read-only`, or `coding` (default: `coding`) |
| `--dry-run` | Validate and print graph structure without executing |

**Examples:**

```
/attractor run                          # Interactive picker + goal prompt
/attractor run deploy                   # Run "deploy" workflow, prompt for goal if needed
/attractor run ./pipelines/feature.awf.kdl --tools read-only
/attractor run deploy --resume          # Resume without goal prompt
/attractor run deploy --dry-run
```

### `/attractor validate`

Check a pipeline graph for errors without executing it.

```
/attractor validate [<workflow>]
```

When `<workflow>` is omitted, an interactive picker is shown (same as `run`).

**Examples:**

```
/attractor validate                     # Interactive picker
/attractor validate deploy
/attractor validate ./pipelines/feature.awf.kdl
```

### `/attractor show`

Visualize a pipeline graph as ASCII art, box art, or DOT notation.

```
/attractor show <workflow> [--format ascii|boxart|dot]
```

**Examples:**

```
/attractor show deploy
/attractor show deploy --format dot
```

## Workflow Discovery

When you provide a bare name (no path separator, no extension), the extension looks for the workflow in:

1. `.attractor/workflows/<name>.awf.kdl` in the current directory

When you provide a path (relative or absolute), it's used directly.

**Interactive picker scope:** The workflow picker currently discovers workflows from `.attractor/workflows/*.awf.kdl` only. Files that fail to parse are skipped with a warning.

## Workflow Description

Workflows can include an optional `description` field at the root level:

```kdl
workflow "deploy" {
  version 2
  description "Deploy the application to production with blue-green strategy"
  start "plan"
  // ...
}
```

The description is shown in the workflow picker and in the preview before execution. Workflows without a description remain fully valid and display gracefully.

## TUI Panel

During execution, the extension displays:

- **Status bar** — Current pipeline state (running, completed, failed, cancelled)
- **Progress widget** — Per-stage status with elapsed time
- **Workflow preview** — Name, description, path, and stage info shown before execution
- **Notifications** — Gate prompts, errors, and final summary

Human gates (hexagon nodes) are presented as pi UI dialogs:
- Yes/No questions → confirmation dialog
- Multiple choice → selection dialog
- Freeform input → text input dialog

## Runtime Behavior

The extension uses the same execution semantics as the `attractor` CLI:

- **Model/Provider**: Uses `claude-opus-4-6` on `anthropic` (matches CLI defaults)
- **Tools**: Full coding tools by default (`read`, `bash`, `edit`, `write`)
- **Checkpointing**: Saves checkpoint to `<logs>/checkpoint.json` for resume
- **Cancellation**: Supports abort via pi's cancellation mechanisms

## Differences from CLI

| Feature | CLI (`attractor run`) | Extension (`/attractor run`) |
|---------|----------------------|------------------------------|
| Output | Terminal spinner + ANSI | Pi TUI panel + widgets |
| Human gates | stdin/stdout readline | Pi UI dialogs |
| Workflow selection | Required argument | Interactive picker or argument |
| Goal | `--goal` flag | Interactive prompt (when needed) |
| Model selection | `--model` / `--provider` flags | Uses CLI defaults |
| Process exit | `process.exit()` on failure | Notification only |
