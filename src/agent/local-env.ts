/**
 * LocalExecutionEnvironment — Section 4.2 of the Coding Agent Loop Spec.
 */

import { exec } from "node:child_process";
import { readFile, writeFile, stat, readdir, mkdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { platform as osPlatform } from "node:os";
import type { ExecutionEnvironment, ExecResult, DirEntry } from "./types.js";

export class LocalExecutionEnvironment implements ExecutionEnvironment {
  private _workingDir: string;

  constructor(workingDir: string) {
    this._workingDir = resolve(workingDir);
  }

  working_directory(): string {
    return this._workingDir;
  }

  platform(): string {
    return osPlatform();
  }

  async read_file(path: string, offset?: number, limit?: number): Promise<string> {
    const absPath = resolve(this._workingDir, path);
    const content = await readFile(absPath, "utf-8");
    const lines = content.split("\n");
    const start = (offset ?? 1) - 1;
    const end = limit ? start + limit : lines.length;
    return lines.slice(start, end).join("\n");
  }

  async write_file(path: string, content: string): Promise<void> {
    const absPath = resolve(this._workingDir, path);
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, content, "utf-8");
  }

  async file_exists(path: string): Promise<boolean> {
    try {
      await stat(resolve(this._workingDir, path));
      return true;
    } catch {
      return false;
    }
  }

  async list_directory(path: string, depth = 1): Promise<DirEntry[]> {
    const absPath = resolve(this._workingDir, path);
    const entries = await readdir(absPath, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      is_dir: e.isDirectory(),
    }));
  }

  async exec_command(
    command: string,
    timeout_ms: number,
    working_dir?: string,
    env_vars?: Record<string, string>,
  ): Promise<ExecResult> {
    const cwd = working_dir ? resolve(this._workingDir, working_dir) : this._workingDir;
    const start = Date.now();

    // Filter env vars (exclude sensitive ones)
    const filteredEnv = { ...process.env, ...env_vars };
    for (const key of Object.keys(filteredEnv)) {
      const upper = key.toUpperCase();
      if (
        upper.endsWith("_API_KEY") ||
        upper.endsWith("_SECRET") ||
        upper.endsWith("_TOKEN") ||
        upper.endsWith("_PASSWORD") ||
        upper.endsWith("_CREDENTIAL")
      ) {
        delete filteredEnv[key];
      }
    }

    return new Promise((resolve) => {
      const child = exec(command, {
        cwd,
        timeout: timeout_ms,
        killSignal: "SIGTERM",
        env: filteredEnv,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      }, (error, stdout, stderr) => {
        const duration_ms = Date.now() - start;
        const timed_out = error?.killed ?? false;
        const exit_code = error?.code != null
          ? (typeof error.code === "number" ? error.code : 1)
          : 0;

        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exit_code,
          timed_out,
          duration_ms,
        });
      });
    });
  }

  async grep(
    pattern: string,
    path: string,
    options?: { case_insensitive?: boolean; max_results?: number },
  ): Promise<string> {
    const absPath = resolve(this._workingDir, path);
    const flags = options?.case_insensitive ? "-rni" : "-rn";
    const maxFlag = options?.max_results ? `-m ${options.max_results}` : "";
    const result = await this.exec_command(
      `grep ${flags} ${maxFlag} ${JSON.stringify(pattern)} ${JSON.stringify(absPath)} 2>/dev/null || true`,
      10_000,
    );
    return result.stdout;
  }

  async glob(pattern: string, path: string): Promise<string[]> {
    const absPath = resolve(this._workingDir, path);
    const result = await this.exec_command(
      `find ${JSON.stringify(absPath)} -name ${JSON.stringify(pattern)} -type f 2>/dev/null | head -500 || true`,
      10_000,
    );
    return result.stdout.split("\n").filter(Boolean);
  }
}
