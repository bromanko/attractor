---
name: tsserver
description: TypeScript language server tools for incremental type checking, type inspection, and find-references. Use after editing TypeScript files to verify type safety without a full build, before refactoring to understand impact, or when unsure about a type.
---

# TypeScript Language Server

This project has `ts_diagnostics`, `ts_type_at`, and `ts_references` tools available via tsserver. They provide faster, more targeted feedback than running `npm run lint` (full `tsc --noEmit`).

## When to use these tools

### After editing a TypeScript file

Call `ts_diagnostics` on the file you just edited before moving to the next file or declaring the task done. This catches type errors incrementally without a full project build.

```
ts_diagnostics { "file": "src/pipeline/executor.ts" }
```

If diagnostics are found, fix them before continuing. This is faster than waiting for `npm run lint` at the end.

### Before renaming or refactoring a symbol

Use `ts_references` to find all usages of a symbol before changing it. This is semantically accurate — unlike `rg`, it won't match unrelated identifiers with the same name.

1. Open the file and find the line/column of the symbol
2. Call `ts_references` at that position
3. Review the list of references to understand the blast radius
4. Then make the change

```
ts_references { "file": "src/pipeline/types.ts", "line": 42, "offset": 14 }
```

### When unsure about a type

Use `ts_type_at` to inspect the resolved type of any expression. Useful when:
- A function returns a complex or inferred type
- You need to understand what a variable holds after narrowing
- You're working with generic code and want to see the instantiated type

```
ts_type_at { "file": "src/llm/client.ts", "line": 15, "offset": 10 }
```

## When NOT to use these tools

- **For the final validation pass**: Still run `npm run lint` and `npm test` before finishing. `ts_diagnostics` checks one file at a time; cross-file errors from your change may only show up in dependent files.
- **For simple edits where you're confident about types**: Don't add overhead for trivial changes like string literals or comments.

## Position conventions

- Lines are **1-based** (first line = 1)
- Offsets (columns) are **1-based** (first character = 1)
- Use the `read` tool with line numbers to identify positions, then pass them to `ts_type_at` or `ts_references`

## Workflow example

1. Read a file to understand the code
2. Edit the file
3. `ts_diagnostics` on the edited file → fix any errors
4. If you changed an exported symbol, `ts_diagnostics` on key importers too
5. Final `npm run lint` + `npm test` before finishing
