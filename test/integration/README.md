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
| `linear.dot` | Minimal start → work → exit |
| `branching.dot` | Diamond gate with success/fail paths |
| `retry-loop.dot` | max_retries + fix loop back to CI |
| `human-gate.dot` | Hexagon node with multiple choices |
| `tool-node.dot` | Parallelogram running a shell command |
| `goal-gate.dot` | goal_gate=true blocking exit |
| `multi-review.dot` | Serial review chain with early-exit on failure |
| `variable-expansion.dot` | $goal substitution in prompts |
| `weighted-edges.dot` | Edge weight tiebreaking |
| `checkpoint-resume.dot` | Run, checkpoint, resume |
| `fail-halts.dot` | Non-routing failure stops pipeline |
| `fail-to-gate.dot` | Failure forwarded through unconditional edge to gate |
| `large-pipeline.dot` | 15+ node stress test |
