Revised plan:

1. **Summary**
   1. Build an installable **pi package extension** that adds `/attractor` as a command-only integration.
   2. MVP scope is only **`run`** and **`validate`** subcommands.
   3. Reuse core Attractor execution (`parseDot`, `validateOrRaise`, `runPipeline`, `PiBackend`) and keep runtime semantics aligned with existing CLI behavior.

2. **Locked decisions from feedback**
   1. `/attractor` is **command-only** (not an LLM-callable tool).
   2. UX is **always interactive** in pi for this scope.
   3. Target is an **installable pi package**.
   4. Include only **`run`** and **`validate`**.
   5. **Do not add `list-models`**.
   6. Model/provider behavior should stay the same as CLI/workflow behavior (no pi-session model override logic).
   7. Implement a **rich custom TUI panel**.
   8. **Defer workflow search expansion** (keep existing local resolution strategy and TODO).

3. **Files to change**
   1. **Create `src/extensions/attractor.ts`**
      - Register `/attractor`.
      - Dispatch subcommands to helpers.
   2. **Create `src/extensions/attractor-command.ts`**
      - Parse args/subcommands.
      - Resolve workflow path using current local strategy (`.attractor/workflows/...`).
      - Produce clear resolution errors.
   3. **Create `src/extensions/attractor-interviewer.ts`**
      - Implement `Interviewer` via `ctx.ui` for approve/revise/select flows.
   4. **Create `src/extensions/attractor-panel.ts`**
      - Rich panel for lifecycle, node/stage progress, gate prompts, decisions, and final summary.
   5. **Minimal refactor of shared execution logic (if needed)**
      - Extract reusable run/validate service only to avoid duplication.
      - Keep CLI-only concerns (`process.exit`, stdout spinner) out of shared code.
   6. **Modify `package.json`**
      - Add `pi.extensions` manifest entry pointing to built output.
      - Add pi package metadata for install/discovery.
   7. **Create tests**
      - `src/extensions/attractor-command.test.ts`
      - `src/extensions/attractor-interviewer.test.ts`
      - `src/extensions/attractor.test.ts`
   8. **Create docs**
      - `docs/attractor-extension.md` with install + usage for `run`/`validate`.

4. **Command contract (MVP)**
   1. `run`  
      `/attractor run <workflow-or-path> --goal "..." [--resume] [--approve-all] [--logs <path>] [--tools <spec>] [--dry-run]`
   2. `validate`  
      `/attractor validate <workflow-or-path>`

5. **Implementation flow**
   1. Parse command + resolve workflow.
   2. `validate`: parse/validate graph, report diagnostics in panel.
   3. `run`: initialize backend + interviewer, stream events to panel.
   4. Support cancellation via `AbortController` and reflect cancelled state in UI.
   5. Emit final summary (success/failure/cancelled + logs/checkpoint hints).

6. **Out of scope**
   1. Extra subcommands (`list-models`, etc.).
   2. Non-interactive/headless extension mode.
   3. Expanded workflow discovery paths beyond current local logic.

7. **Acceptance criteria**
   1. `/attractor run ...` executes workflows in pi with interactive human gates and rich panel updates.
   2. `/attractor validate ...` reports valid/invalid graph status with actionable errors.
   3. Extension is installable/discoverable as a pi package.
   4. Runtime behavior matches CLI semantics except for UI presentation.