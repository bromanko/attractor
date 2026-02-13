/**
 * graph-easy.ts — Shared helpers for detecting and invoking `graph-easy`.
 *
 * Used by both the CLI (`cli.ts`) and the pi extension (`attractor.ts`)
 * to render DOT graphs as ASCII/boxart via the `graph-easy` tool.
 */

import { execFile } from "node:child_process";

/** Check if `graph-easy` is on PATH. */
export function hasGraphEasy(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("graph-easy", ["--version"], { timeout: 5_000 }, (err) => {
      // graph-easy may exit non-zero for --version but that still means it's installed.
      // A spawn error (ENOENT) means it's missing.
      const isSpawnError = err !== null && (err as NodeJS.ErrnoException).code === "ENOENT";
      resolve(!isSpawnError);
    });
  });
}

const GRAPH_EASY_FORMATS: ReadonlySet<string> = new Set(["ascii", "boxart"]);

/** Pipe a DOT string through `graph-easy` with the given output format. */
export function runGraphEasy(dot: string, format: "ascii" | "boxart"): Promise<string> {
  if (!GRAPH_EASY_FORMATS.has(format)) {
    return Promise.reject(new Error(`Invalid graph-easy format: ${format}`));
  }
  return new Promise((resolve, reject) => {
    const proc = execFile(
      "graph-easy",
      ["--from=dot", `--as=${format}`],
      { maxBuffer: 1024 * 1024, timeout: 30_000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`graph-easy failed: ${stderr || err.message}`));
        } else {
          resolve(stdout);
        }
      },
    );
    proc.stdin?.write(dot);
    proc.stdin?.end();
  });
}
