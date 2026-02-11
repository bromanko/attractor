# Attractor Pi Extension

Run and validate Attractor DOT-based AI pipelines directly inside [pi](https://github.com/badlogic/pi-mono), the CLI coding agent.

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
/attractor run <workflow> --goal "..." [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<workflow>` | Path to `.dot` file, or bare name resolved from `.attractor/workflows/` |
| `--goal <text>` | Pipeline goal (overrides graph's `goal` attribute) |
| `--resume` | Resume from last checkpoint (`<logs>/checkpoint.json`) |
| `--approve-all` | Auto-approve all human gates (no interactive prompts) |
| `--logs <dir>` | Logs directory (default: `.attractor/logs`) |
| `--tools <mode>` | Tool mode: `none`, `read-only`, or `coding` (default: `coding`) |
| `--dry-run` | Validate and print graph structure without executing |

**Examples:**

```
/attractor run deploy --goal "Deploy v2.1 to staging"
/attractor run ./pipelines/feature.dot --goal "Implement auth" --tools read-only
/attractor run deploy --resume
/attractor run deploy --dry-run
```

### `/attractor validate`

Check a pipeline graph for errors without executing it.

```
/attractor validate <workflow>
```

**Examples:**

```
/attractor validate deploy
/attractor validate ./pipelines/feature.dot
```

## Workflow Resolution

When you provide a bare name (no path separator, no `.dot` extension), the extension looks for the workflow in:

1. `.attractor/workflows/<name>.dot` in the current directory

When you provide a path (relative or absolute), it's used directly.

## TUI Panel

During execution, the extension displays:

- **Status bar** — Current pipeline state (running, completed, failed, cancelled)
- **Progress widget** — Per-stage status with elapsed time
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
| Model selection | `--model` / `--provider` flags | Uses CLI defaults |
| Process exit | `process.exit()` on failure | Notification only |
