# Attractor Integration Tests

End-to-end tests that exercise the full pipeline engine through real DOT
workflow files. Each workflow targets a specific feature or failure mode.

## Running

```bash
npm run test:integration
```

These tests use mock backends (no LLM calls, no network, no jj). They
validate the engine's graph traversal, edge selection, retries, human gates,
tool execution, checkpointing, and CLI surface.

## Test Workflows

| Workflow | What it covers |
|---|---|
| `linear.awf.kdl` | Minimal start → work → exit |
| `branching.awf.kdl` | Decision gate with success/fail paths |
| `retry-loop.awf.kdl` | retry + fix loop back to CI |
| `human-gate.awf.kdl` | Human stage with multiple choices |
| `tool-node.awf.kdl` | Tool stage running a shell command |
| `goal-gate.awf.kdl` | goal_gate=true blocking exit |
| `multi-review.awf.kdl` | Serial review chain with early-exit on failure |
| `variable-expansion.awf.kdl` | $goal substitution in prompts |
| `weighted-edges.awf.kdl` | Transition priority selection |
| `checkpoint-resume.awf.kdl` | Run, checkpoint, resume |
| `fail-halts.awf.kdl` | Non-routing failure stops pipeline |
| `fail-to-gate.awf.kdl` | Failure forwarded through decision gate |
| `large-pipeline.awf.kdl` | 15+ node stress test |
