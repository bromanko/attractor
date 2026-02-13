/**
 * TypeScript Language Server Extension
 *
 * Provides tools for incremental type checking, type inspection,
 * and find-references via tsserver. The server is started lazily
 * on first tool call and reused for the session.
 *
 * Tools:
 *   ts_diagnostics  — file-level or project-wide type errors
 *   ts_type_at      — hover/type info at a position
 *   ts_references   — find all references to a symbol
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { type ChildProcess, spawn } from "node:child_process";
import { resolve, relative } from "node:path";
import { createInterface, type Interface } from "node:readline";

// ── tsserver JSON protocol client ──────────────────────────────────

interface TsServerResponse {
	seq: number;
	type: string;
	command: string;
	request_seq: number;
	success: boolean;
	message?: string;
	body?: unknown;
}

interface TsServerEvent {
	seq: number;
	type: "event";
	event: string;
	body?: unknown;
}

type TsServerMessage = TsServerResponse | TsServerEvent;

class TsServerClient {
	private process: ChildProcess | null = null;
	private reader: Interface | null = null;
	private seq = 0;
	private pending = new Map<
		number,
		{
			resolve: (v: TsServerResponse) => void;
			reject: (e: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	private openFiles = new Set<string>();
	private cwd: string;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	async start(): Promise<void> {
		if (this.process) return;

		const tsserverPath = resolve(this.cwd, "node_modules", "typescript", "lib", "tsserver.js");

		this.process = spawn("node", [tsserverPath, "--disableAutomaticTypingAcquisition"], {
			cwd: this.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, TSS_LOG: "" },
		});

		this.process.on("exit", () => {
			this.cleanup();
		});

		this.process.on("error", (err) => {
			console.error("[tsserver] process error:", err.message);
			this.cleanup();
		});

		if (!this.process.stdout) throw new Error("tsserver stdout not available");

		this.reader = createInterface({ input: this.process.stdout });

		// Content-Length framed protocol
		let contentLength = -1;
		let buffer = "";

		this.reader.on("line", (line) => {
			if (line.startsWith("Content-Length:")) {
				contentLength = parseInt(line.slice("Content-Length:".length).trim(), 10);
				buffer = "";
				return;
			}

			if (line === "" && contentLength >= 0) {
				// Next line(s) will be the JSON body — handled below
				return;
			}

			if (contentLength >= 0) {
				buffer += line;
				// Attempt parse when we have enough data
				try {
					const msg = JSON.parse(buffer) as TsServerMessage;
					contentLength = -1;
					buffer = "";
					this.handleMessage(msg);
				} catch {
					// Incomplete JSON, wait for more lines
				}
			}
		});

		// Wait for tsserver to be ready by sending a configure request
		await this.request("configure", {
			hostInfo: "pi-extension",
			preferences: {
				disableSuggestions: true,
			},
		});
	}

	private handleMessage(msg: TsServerMessage): void {
		if (msg.type === "response") {
			const resp = msg as TsServerResponse;
			const entry = this.pending.get(resp.request_seq);
			if (entry) {
				clearTimeout(entry.timer);
				this.pending.delete(resp.request_seq);
				entry.resolve(resp);
			}
		}
		// Events (diagnostics events, etc.) are ignored for now
	}

	async request(command: string, args?: Record<string, unknown>, timeoutMs = 30_000): Promise<TsServerResponse> {
		if (!this.process?.stdin) throw new Error("tsserver not running");

		const seq = ++this.seq;
		const msg = JSON.stringify({ seq, type: "request", command, arguments: args });

		return new Promise<TsServerResponse>((res, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(seq);
				reject(new Error(`tsserver request '${command}' timed out after ${timeoutMs}ms`));
			}, timeoutMs);

			this.pending.set(seq, { resolve: res, reject, timer });
			this.process!.stdin!.write(msg + "\n");
		});
	}

	async openFile(file: string, content?: string): Promise<void> {
		if (!this.process?.stdin) throw new Error("tsserver not running");
		const absPath = resolve(this.cwd, file);
		if (this.openFiles.has(absPath)) {
			// Reload to pick up external changes
			await this.request("reload", {
				file: absPath,
				tmpfile: absPath,
			});
			return;
		}
		// "open" is a fire-and-forget command (no response from tsserver)
		const args: Record<string, unknown> = { file: absPath };
		if (content !== undefined) args.fileContent = content;
		const seq = ++this.seq;
		const msg = JSON.stringify({ seq, type: "request", command: "open", arguments: args });
		this.process.stdin.write(msg + "\n");
		this.openFiles.add(absPath);
		// Give tsserver a moment to process the file
		await new Promise((r) => setTimeout(r, 100));
	}

	async closeFile(file: string): Promise<void> {
		if (!this.process?.stdin) return;
		const absPath = resolve(this.cwd, file);
		if (!this.openFiles.has(absPath)) return;
		// "close" is also fire-and-forget
		const seq = ++this.seq;
		const msg = JSON.stringify({ seq, type: "request", command: "close", arguments: { file: absPath } });
		this.process.stdin.write(msg + "\n");
		this.openFiles.delete(absPath);
	}

	isRunning(): boolean {
		return this.process !== null && this.process.exitCode === null;
	}

	shutdown(): void {
		if (this.process) {
			try {
				this.process.stdin?.write(
					JSON.stringify({ seq: ++this.seq, type: "request", command: "exit" }) + "\n",
				);
			} catch {
				// Process may already be dead
			}
			setTimeout(() => {
				if (this.process && this.process.exitCode === null) {
					this.process.kill("SIGTERM");
				}
			}, 2000);
		}
		this.cleanup();
	}

	private cleanup(): void {
		for (const [, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(new Error("tsserver shut down"));
		}
		this.pending.clear();
		this.openFiles.clear();
		this.reader?.close();
		this.reader = null;
		this.process = null;
	}
}

// ── Extension ──────────────────────────────────────────────────────

export default function tsserverExtension(pi: ExtensionAPI) {
	let client: TsServerClient | null = null;
	let cwd: string = process.cwd();

	async function ensureClient(): Promise<TsServerClient> {
		if (client && client.isRunning()) return client;
		client = new TsServerClient(cwd);
		await client.start();
		return client;
	}

	// ── ts_diagnostics ─────────────────────────────────────────────

	interface DiagnosticsDetails {
		file: string;
		diagnosticCount: number;
		truncated: boolean;
	}

	pi.registerTool({
		name: "ts_diagnostics",
		label: "TS Diagnostics",
		description:
			`Get TypeScript type errors and diagnostics for a file. ` +
			`Faster than a full \`tsc --noEmit\` for checking individual files after edits. ` +
			`Output truncated to ${DEFAULT_MAX_LINES} lines / ${formatSize(DEFAULT_MAX_BYTES)}.`,
		parameters: Type.Object({
			file: Type.String({
				description: "Path to the TypeScript file (relative to project root)",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			cwd = ctx.cwd;
			const tsClient = await ensureClient();
			const file = params.file.replace(/^@/, "");
			const absPath = resolve(ctx.cwd, file);

			await tsClient.openFile(file);

			// Request semantic + syntactic diagnostics
			const [semantic, syntactic, suggestion] = await Promise.all([
				tsClient.request("semanticDiagnosticsSync", { file: absPath, includeLinePosition: true }),
				tsClient.request("syntacticDiagnosticsSync", { file: absPath, includeLinePosition: true }),
				tsClient.request("suggestionDiagnosticsSync", { file: absPath, includeLinePosition: true }),
			]);

			const allDiags: Array<{
				category: string;
				code: number;
				text: string;
				start?: { line: number; offset: number };
				end?: { line: number; offset: number };
			}> = [];

			for (const resp of [syntactic, semantic, suggestion]) {
				if (resp.success && Array.isArray(resp.body)) {
					for (const d of resp.body as Array<Record<string, unknown>>) {
						allDiags.push({
							category: d.category as string ?? "error",
							code: (d.code as number) ?? 0,
							text: (d.text as string) ?? (d.message as string) ?? "unknown",
							start: d.startLocation as { line: number; offset: number } | undefined,
							end: d.endLocation as { line: number; offset: number } | undefined,
						});
					}
				}
			}

			if (allDiags.length === 0) {
				return {
					content: [{ type: "text", text: `No diagnostics found in ${file}` }],
					details: { file, diagnosticCount: 0, truncated: false } satisfies DiagnosticsDetails,
				};
			}

			const relFile = relative(ctx.cwd, absPath);
			const lines = allDiags.map((d) => {
				const loc = d.start ? `:${d.start.line}:${d.start.offset}` : "";
				return `${relFile}${loc} - ${d.category} TS${d.code}: ${d.text}`;
			});

			const output = lines.join("\n");
			const truncation = truncateHead(output, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			let resultText = truncation.content;
			if (truncation.truncated) {
				resultText += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines]`;
			}

			return {
				content: [{ type: "text", text: resultText }],
				details: {
					file,
					diagnosticCount: allDiags.length,
					truncated: truncation.truncated,
				} satisfies DiagnosticsDetails,
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("ts_diagnostics "));
			text += theme.fg("accent", args.file as string);
			return new Text(text, 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Checking…"), 0, 0);
			const details = result.details as DiagnosticsDetails | undefined;
			if (!details || details.diagnosticCount === 0) {
				return new Text(theme.fg("success", "✓ No errors"), 0, 0);
			}
			let text = theme.fg("error", `${details.diagnosticCount} diagnostic(s)`);
			if (details.truncated) text += theme.fg("warning", " (truncated)");
			return new Text(text, 0, 0);
		},
	});

	// ── ts_type_at ─────────────────────────────────────────────────

	interface TypeAtDetails {
		file: string;
		line: number;
		offset: number;
		type?: string;
		documentation?: string;
	}

	pi.registerTool({
		name: "ts_type_at",
		label: "TS Type At",
		description:
			"Get the TypeScript type and documentation for a symbol at a specific position in a file. " +
			"Useful for understanding types when editing or debugging.",
		parameters: Type.Object({
			file: Type.String({ description: "Path to the TypeScript file" }),
			line: Type.Number({ description: "Line number (1-based)" }),
			offset: Type.Number({ description: "Column offset (1-based)" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			cwd = ctx.cwd;
			const tsClient = await ensureClient();
			const file = params.file.replace(/^@/, "");
			const absPath = resolve(ctx.cwd, file);

			await tsClient.openFile(file);

			const resp = await tsClient.request("quickinfo", {
				file: absPath,
				line: params.line,
				offset: params.offset,
			});

			if (!resp.success || !resp.body) {
				return {
					content: [{ type: "text", text: `No type information at ${file}:${params.line}:${params.offset}` }],
					details: { file, line: params.line, offset: params.offset } satisfies TypeAtDetails,
				};
			}

			const body = resp.body as Record<string, unknown>;
			const displayString = (body.displayString as string) ?? "";
			const documentation = (body.documentation as string) ?? "";

			let resultText = displayString;
			if (documentation) {
				resultText += `\n\n${documentation}`;
			}

			return {
				content: [{ type: "text", text: resultText }],
				details: {
					file,
					line: params.line,
					offset: params.offset,
					type: displayString,
					documentation: documentation || undefined,
				} satisfies TypeAtDetails,
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("ts_type_at "));
			text += theme.fg("accent", `${args.file}:${args.line}:${args.offset}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Resolving…"), 0, 0);
			const details = result.details as TypeAtDetails | undefined;
			if (!details?.type) return new Text(theme.fg("dim", "No type info"), 0, 0);
			return new Text(theme.fg("success", details.type), 0, 0);
		},
	});

	// ── ts_references ──────────────────────────────────────────────

	interface ReferencesDetails {
		file: string;
		line: number;
		offset: number;
		referenceCount: number;
		truncated: boolean;
	}

	pi.registerTool({
		name: "ts_references",
		label: "TS References",
		description:
			"Find all references to a symbol at a given position. " +
			"More accurate than text search — uses semantic analysis. " +
			`Output truncated to ${DEFAULT_MAX_LINES} lines / ${formatSize(DEFAULT_MAX_BYTES)}.`,
		parameters: Type.Object({
			file: Type.String({ description: "Path to the TypeScript file" }),
			line: Type.Number({ description: "Line number (1-based)" }),
			offset: Type.Number({ description: "Column offset (1-based)" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			cwd = ctx.cwd;
			const tsClient = await ensureClient();
			const file = params.file.replace(/^@/, "");
			const absPath = resolve(ctx.cwd, file);

			await tsClient.openFile(file);

			const resp = await tsClient.request("references", {
				file: absPath,
				line: params.line,
				offset: params.offset,
			});

			if (!resp.success || !resp.body) {
				return {
					content: [{ type: "text", text: `No references found at ${file}:${params.line}:${params.offset}` }],
					details: {
						file, line: params.line, offset: params.offset,
						referenceCount: 0, truncated: false,
					} satisfies ReferencesDetails,
				};
			}

			const body = resp.body as { refs?: Array<Record<string, unknown>>; symbolName?: string };
			const refs = body.refs ?? [];
			const symbolName = body.symbolName ?? "symbol";

			if (refs.length === 0) {
				return {
					content: [{ type: "text", text: `No references found for '${symbolName}'` }],
					details: {
						file, line: params.line, offset: params.offset,
						referenceCount: 0, truncated: false,
					} satisfies ReferencesDetails,
				};
			}

			const lines = refs.map((ref) => {
				const refFile = relative(ctx.cwd, (ref.file as string) ?? "");
				const start = ref.start as { line: number; offset: number } | undefined;
				const loc = start ? `:${start.line}:${start.offset}` : "";
				const lineText = ((ref.lineText as string) ?? "").trim();
				const isDefinition = ref.isDefinition ? " [definition]" : "";
				return `${refFile}${loc}${isDefinition}: ${lineText}`;
			});

			const output = `References to '${symbolName}' (${refs.length}):\n\n${lines.join("\n")}`;
			const truncation = truncateHead(output, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			let resultText = truncation.content;
			if (truncation.truncated) {
				resultText += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines]`;
			}

			return {
				content: [{ type: "text", text: resultText }],
				details: {
					file, line: params.line, offset: params.offset,
					referenceCount: refs.length,
					truncated: truncation.truncated,
				} satisfies ReferencesDetails,
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("ts_references "));
			text += theme.fg("accent", `${args.file}:${args.line}:${args.offset}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Searching…"), 0, 0);
			const details = result.details as ReferencesDetails | undefined;
			if (!details || details.referenceCount === 0) {
				return new Text(theme.fg("dim", "No references found"), 0, 0);
			}
			let text = theme.fg("success", `${details.referenceCount} reference(s)`);
			if (details.truncated) text += theme.fg("warning", " (truncated)");
			return new Text(text, 0, 0);
		},
	});

	// ── Lifecycle ──────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
	});

	pi.on("session_shutdown", async () => {
		if (client) {
			client.shutdown();
			client = null;
		}
	});
}
