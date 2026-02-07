/**
 * Shared core tools — Section 3.3 of the Coding Agent Loop Spec.
 */

import type { RegisteredTool, ExecutionEnvironment, ToolRegistry as IToolRegistry } from "./types.js";
import type { ToolDefinition } from "../llm/index.js";

// ---------------------------------------------------------------------------
// Tool registry implementation
// ---------------------------------------------------------------------------

export function createToolRegistry(): IToolRegistry {
  const tools = new Map<string, RegisteredTool>();
  return {
    tools,
    register(tool: RegisteredTool) {
      tools.set(tool.definition.name, tool);
    },
    unregister(name: string) {
      tools.delete(name);
    },
    get(name: string) {
      return tools.get(name);
    },
    definitions(): ToolDefinition[] {
      return Array.from(tools.values()).map((t) => t.definition);
    },
  };
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

export const readFileTool: RegisteredTool = {
  definition: {
    name: "read_file",
    description: "Read a file from the filesystem. Returns line-numbered content.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path to the file" },
        offset: { type: "integer", description: "1-based line number to start reading from" },
        limit: { type: "integer", description: "Max lines to read (default: 2000)" },
      },
      required: ["file_path"],
    },
  },
  async executor(args: Record<string, unknown>, env: ExecutionEnvironment): Promise<string> {
    const filePath = args.file_path as string;
    const offset = args.offset as number | undefined;
    const limit = args.limit as number | undefined;
    const content = await env.read_file(filePath, offset, limit);

    // Add line numbers
    const lines = content.split("\n");
    const startLine = offset ?? 1;
    return lines
      .map((line, i) => `${String(startLine + i).padStart(4)} | ${line}`)
      .join("\n");
  },
};

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

export const writeFileTool: RegisteredTool = {
  definition: {
    name: "write_file",
    description: "Write content to a file. Creates the file and parent directories if needed.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path" },
        content: { type: "string", description: "The full file content" },
      },
      required: ["file_path", "content"],
    },
  },
  async executor(args: Record<string, unknown>, env: ExecutionEnvironment): Promise<string> {
    const filePath = args.file_path as string;
    const content = args.content as string;
    await env.write_file(filePath, content);
    const bytes = Buffer.byteLength(content, "utf-8");
    return `Wrote ${bytes} bytes to ${filePath}`;
  },
};

// ---------------------------------------------------------------------------
// edit_file (Anthropic-style old_string/new_string)
// ---------------------------------------------------------------------------

export const editFileTool: RegisteredTool = {
  definition: {
    name: "edit_file",
    description: "Replace an exact string occurrence in a file.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path" },
        old_string: { type: "string", description: "Exact text to find" },
        new_string: { type: "string", description: "Replacement text" },
        replace_all: { type: "boolean", description: "Replace all occurrences (default: false)" },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
  async executor(args: Record<string, unknown>, env: ExecutionEnvironment): Promise<string> {
    const filePath = args.file_path as string;
    const oldString = args.old_string as string;
    const newString = args.new_string as string;
    const replaceAll = (args.replace_all as boolean) ?? false;

    const content = await env.read_file(filePath);

    if (!content.includes(oldString)) {
      throw new Error(`old_string not found in ${filePath}. Make sure it matches exactly.`);
    }

    if (!replaceAll) {
      const firstIdx = content.indexOf(oldString);
      const secondIdx = content.indexOf(oldString, firstIdx + 1);
      if (secondIdx !== -1) {
        throw new Error(
          `old_string matches multiple locations in ${filePath}. ` +
          `Provide more context to make the match unique, or set replace_all=true.`
        );
      }
    }

    const newContent = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);

    await env.write_file(filePath, newContent);
    const count = replaceAll
      ? content.split(oldString).length - 1
      : 1;
    return `Made ${count} replacement(s) in ${filePath}`;
  },
};

// ---------------------------------------------------------------------------
// shell
// ---------------------------------------------------------------------------

export const shellTool: RegisteredTool = {
  definition: {
    name: "shell",
    description: "Execute a shell command. Returns stdout, stderr, and exit code.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run" },
        timeout_ms: { type: "integer", description: "Override default timeout" },
        description: { type: "string", description: "Human-readable description" },
      },
      required: ["command"],
    },
  },
  async executor(args: Record<string, unknown>, env: ExecutionEnvironment): Promise<string> {
    const command = args.command as string;
    const timeoutMs = (args.timeout_ms as number) ?? 10_000;

    const result = await env.exec_command(command, timeoutMs);

    let output = "";
    if (result.stdout) output += result.stdout;
    if (result.stderr) output += (output ? "\n" : "") + result.stderr;

    if (result.timed_out) {
      output +=
        `\n[ERROR: Command timed out after ${timeoutMs}ms. Partial output is shown above.\n` +
        `You can retry with a longer timeout by setting the timeout_ms parameter.]`;
    }

    if (!result.timed_out && result.exit_code !== 0) {
      output += `\n[Exit code: ${result.exit_code}]`;
    }

    return output || "(no output)";
  },
};

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

export const grepTool: RegisteredTool = {
  definition: {
    name: "grep",
    description: "Search file contents using regex patterns.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern" },
        path: { type: "string", description: "Directory or file to search" },
        case_insensitive: { type: "boolean", description: "Case insensitive (default: false)" },
        max_results: { type: "integer", description: "Max results (default: 100)" },
      },
      required: ["pattern"],
    },
  },
  async executor(args: Record<string, unknown>, env: ExecutionEnvironment): Promise<string> {
    const pattern = args.pattern as string;
    const path = (args.path as string) ?? env.working_directory();
    const caseInsensitive = (args.case_insensitive as boolean) ?? false;
    const maxResults = (args.max_results as number) ?? 100;

    return env.grep(pattern, path, { case_insensitive: caseInsensitive, max_results: maxResults });
  },
};

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

export const globTool: RegisteredTool = {
  definition: {
    name: "glob",
    description: "Find files matching a glob pattern.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern (e.g., '**/*.ts')" },
        path: { type: "string", description: "Base directory" },
      },
      required: ["pattern"],
    },
  },
  async executor(args: Record<string, unknown>, env: ExecutionEnvironment): Promise<string> {
    const pattern = args.pattern as string;
    const path = (args.path as string) ?? env.working_directory();
    const files = await env.glob(pattern, path);
    return files.join("\n");
  },
};

/** All shared core tools. */
export const CORE_TOOLS: RegisteredTool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  shellTool,
  grepTool,
  globTool,
];
