/**
 * `pwsh` - persistent PowerShell 7 session tool for OMP.
 *
 * One long-lived `pwsh -File runner.ps1` subprocess per (cwd, session) key.
 * State (variables, modules, location) survives across calls, so module
 * imports are paid once. Protocol and runner live in `session.ts`/`runner.ps1`.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import hljs from "highlight.js/lib/core";
import powershell from "highlight.js/lib/languages/powershell";
import { PwshSessionPool, type PwshRunResult } from "./session";

hljs.registerLanguage("powershell", powershell);

const DEFAULT_TIMEOUT_SEC = 120;
const MIN_TIMEOUT_SEC = 1;
const MAX_TIMEOUT_SEC = 3600;
const DEFAULT_WIDTH = 200;
const MIN_WIDTH = 40;
const MAX_WIDTH = 4096;
const STREAM_PREVIEW_CHARS = 50 * 1024;

export interface PwshParams {
	command: string;
	cwd?: string;
	env?: Record<string, string>;
	format?: "text" | "json";
	width?: number;
	timeout?: number;
	session?: string;
}

export interface PwshDetails {
	cwd: string;
	sessionKey: string;
	format: "text" | "json";
	timeoutSec: number;
	exitCode?: number | null;
	timedOut?: boolean;
	dead?: boolean;
	streaming?: boolean;
	error?: string | null;
	output?: string | null;
	wallTimeMs: number;
}

interface SessionLike {
	run(
		req: { code: string; env?: Record<string, string>; width?: number; format?: "text" | "json" },
		opts: { timeoutMs?: number; signal?: AbortSignal; onChunk?: (text: string) => void },
	): Promise<PwshRunResult>;
}

interface PwshApi {
	getOrCreate(key: string, cwd?: string): SessionLike;
}

/** Session key: cwd + explicit session name. */
export function buildSessionKey(cwd: string, session?: string): string {
	return `${cwd}\n${session ?? ""}`;
}

type PwshUpdate = {
	content: Array<{ type: "text"; text: string }>;
	details?: Partial<PwshDetails>;
};

/** Core execute body - split out for smoke tests. */
export async function runPwsh(
	params: PwshParams,
	api: PwshApi,
	onUpdate?: (update: PwshUpdate) => void,
	signal?: AbortSignal,
): Promise<{ text: string; details: PwshDetails; isError?: boolean }> {
	const started = Date.now();
	const command = params.command;
	const cwd = params.cwd ?? process.cwd();
	onUpdate?.({ content: [{ type: "text", text: `[pwsh] running in session ${buildSessionKey(cwd, params.session)}…` }] });

	// Validate cwd before spawning so a bad path fails fast instead of
	// producing a confusing spawn error.
	const cwdStat = await Bun.file(cwd).stat().catch(() => null);
	if (!cwdStat) {
		return {
			text: `Working directory does not exist: ${cwd}`,
			details: emptyDetails(params, cwd, `Working directory does not exist: ${cwd}`),
			isError: true,
		};
	}
	if (!cwdStat.isDirectory()) {
		return {
			text: `Working directory is not a directory: ${cwd}`,
			details: emptyDetails(params, cwd, `Working directory is not a directory: ${cwd}`),
			isError: true,
		};
	}

	const timeoutSec = normalizeTimeout(params.timeout);
	const width = normalizeWidth(params.width);
	const format = params.format === "json" ? "json" : "text";
	const sessionKey = buildSessionKey(cwd, params.session);
	const session = api.getOrCreate(sessionKey, cwd);
	let streamPreview = "";

	const runResult = await session.run(
		{
			code: command,
			env: params.env,
			width,
			format,
		},
		{
			timeoutMs: timeoutSec === 0 ? undefined : timeoutSec * 1000,
			signal,
			onChunk:
				format === "text"
					? chunk => {
							streamPreview = (streamPreview + chunk).slice(-STREAM_PREVIEW_CHARS);
							onUpdate?.({
								content: [{ type: "text", text: streamPreview }],
								details: {
									cwd,
									sessionKey,
									format,
									timeoutSec,
									streaming: true,
									output: streamPreview,
									wallTimeMs: Date.now() - started,
								},
							});
						}
					: undefined,
		},
	);

	const wallTimeMs = Date.now() - started;
	const details: PwshDetails = {
		cwd,
		sessionKey,
		format,
		timeoutSec,
		wallTimeMs,
	};

	if (runResult.busy) {
		return {
			text: runResult.error ?? "session busy (another command is running); retry later",
			details,
			isError: true,
		};
	}
	if (runResult.dead) {
		details.dead = true;
		details.error = runResult.error;
		details.output = runResult.partialOutput;
		return {
			text: `pwsh process died (session rebuilt)${runResult.error ? `: ${runResult.error}` : ""}${
				runResult.partialOutput ? `\n${runResult.partialOutput}` : ""
			}`,
			details,
			isError: true,
		};
	}
	if (runResult.timedOut) {
		details.timedOut = true;
		details.output = runResult.partialOutput;
		return {
			text: `Command timed out (${timeoutSec}s; process tree killed)${runResult.partialOutput ? `\n${runResult.partialOutput}` : ""}`,
			details,
			isError: true,
		};
	}
	if (runResult.aborted) {
		return {
			text: "Command cancelled",
			details,
		};
	}

	const resp = runResult.response;
	details.exitCode = resp?.exitCode ?? null;
	details.error = resp?.error ?? null;
	details.output = resp?.output ?? null;

	// Full output passes through untruncated: the host's wrapToolWithMetaNotice
	// spill (tools.artifactSpillThreshold, default 50 KB) saves oversized
	// results to an artifact and appends `Read artifact://N for full output`,
	// so nothing is lost. Trailing blank lines from Out-String are trimmed so
	// the wire text stays compact.
	let body: string;
	if (resp?.error) {
		body = `Execution error: ${resp.error}`;
	} else if (resp?.output) {
		body = resp.output.replace(/\r\n/g, "\n").replace(/\r/g, "").trimEnd();
	} else {
		body = "(no output)";
	}
	const notices: string[] = [];
	if (resp?.exitCode !== null && resp?.exitCode !== undefined) {
		notices.push(`Exit code: ${resp.exitCode}`);
	}
	notices.push(`Wall time: ${(wallTimeMs / 1000).toFixed(2)} seconds`);
	return {
		text: `${body}\n\n${notices.join(" · ")}`,
		details,
		isError: Boolean(resp?.error),
	};
}

function emptyDetails(params: PwshParams, cwd: string, error: string): PwshDetails {
	return {
		cwd,
		sessionKey: buildSessionKey(cwd, params.session),
		format: params.format === "json" ? "json" : "text",
		timeoutSec: normalizeTimeout(params.timeout),
		error,
		wallTimeMs: 0,
	};
}

function normalizeTimeout(value: number | undefined): number {
	if (value === 0) return 0;
	if (value === undefined) return DEFAULT_TIMEOUT_SEC;
	return Math.max(MIN_TIMEOUT_SEC, Math.min(MAX_TIMEOUT_SEC, Math.round(value)));
}

function normalizeWidth(value: number | undefined): number {
	if (value === undefined) return DEFAULT_WIDTH;
	return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(value)));
}

// ---------------------------------------------------------------------------
// TUI renderer - framed block + syntax highlighting via host-injected pi.pi
// (duck-typed Component; host instance avoids the pi-tui dual-copy trap)
// ---------------------------------------------------------------------------

interface Theme {
	fg(color: string, text: string): string;
	bg?(color: string, text: string): string;
	bold?(text: string): string;
	styledSymbol?(key: string, color: string): string;
	boxRound?: {
		topLeft: string;
		topRight: string;
		bottomLeft: string;
		bottomRight: string;
		horizontal: string;
		vertical: string;
	};
	boxSharp?: {
		teeLeft: string;
		teeRight: string;
		horizontal: string;
	};
}

/** Terminal column width of one char: East Asian wide/fullwidth = 2. */
function charWidth(ch: string): number {
	const c = ch.codePointAt(0) ?? 0;
	if (
		(c >= 0x1100 && c <= 0x115f) || // Hangul Jamo
		(c >= 0x2e80 && c <= 0xa4cf) || // CJK radicals .. Yi
		(c >= 0xac00 && c <= 0xd7a3) || // Hangul syllables
		(c >= 0xf900 && c <= 0xfaff) || // CJK compat ideographs
		(c >= 0xfe30 && c <= 0xfe6f) || // CJK compat forms
		(c >= 0xff00 && c <= 0xff60) || // Fullwidth forms
		(c >= 0xffe0 && c <= 0xffe6) // Fullwidth signs
	) {
		return 2;
	}
	return 1;
}

/** Strip ANSI escapes to measure visible width (wide chars = 2 columns). */
function visibleLength(text: string): number {
	let visible = 0;
	let i = 0;
	while (i < text.length) {
		if (text[i] === "\x1b") {
			const end = text.indexOf("m", i);
			if (end === -1) break;
			i = end + 1;
		} else {
			visible += charWidth(text[i]!);
			i++;
		}
	}
	return visible;
}

/** Slice a possibly-ANSI-colored string to `max` visible columns, preserving escapes. */
function ansiSafeSlice(text: string, max: number): string {
	let visible = 0;
	let out = "";
	let i = 0;
	while (i < text.length) {
		if (text[i] === "\x1b") {
			const end = text.indexOf("m", i);
			if (end === -1) {
				out += text.slice(i);
				break;
			}
			out += text.slice(i, end + 1);
			i = end + 1;
			continue;
		}
		if (visible >= max) break;
		const w = charWidth(text[i]!);
		if (visible + w > max) break;
		out += text[i]!;
		visible += w;
		i++;
	}
	if (i < text.length) out += "…";
	return out;
}

/** Wrap ANSI-colored text into terminal-width rows without dropping characters. */
function wrapAnsiLine(text: string, max: number): string[] {
	if (max <= 0) return [text];
	const rows: string[] = [];
	let row = "";
	let visible = 0;
	let activeSgr = "";
	let i = 0;
	while (i < text.length) {
		if (text[i] === "\x1b") {
			const end = text.indexOf("m", i);
			if (end === -1) {
				row += text.slice(i);
				break;
			}
			const sequence = text.slice(i, end + 1);
			row += sequence;
			if (sequence.startsWith("\x1b[")) {
				const params = sequence.slice(2, -1).split(";").filter(Boolean);
				if (params.length === 0 || params.some(param => param === "0" || param === "39" || param === "49")) {
					activeSgr = "";
				} else {
					activeSgr += sequence;
				}
			}
			i = end + 1;
			continue;
		}

		const codePoint = text.codePointAt(i) ?? 0;
		const char = String.fromCodePoint(codePoint);
		const width = charWidth(char);
		if (visible > 0 && visible + width > max) {
			if (activeSgr) row += "\x1b[0m";
			rows.push(row);
			row = activeSgr;
			visible = 0;
		}
		row += char;
		visible += width;
		i += char.length;
	}
	if (activeSgr) row += "\x1b[0m";
	if (row || rows.length === 0) rows.push(row);
	return rows;
}

// ---------------------------------------------------------------------------
// PowerShell syntax highlighter via highlight.js.
//
// Uses highlight.js/lib/core + highlight.js/lib/languages/powershell to parse
// the full PowerShell grammar (including cmdlets, subexpressions, variables,
// multiline comments/strings, parameter switches) and maps AST token classes
// to OMP theme syntax colors.
// ---------------------------------------------------------------------------

const HLJS_TO_THEME_COLOR: Record<string, string> = {
	keyword: "syntaxKeyword",
	built_in: "syntaxFunction",
	function: "syntaxFunction",
	title: "syntaxFunction",
	string: "syntaxString",
	comment: "syntaxComment",
	doctag: "syntaxComment",
	variable: "syntaxVariable",
	params: "syntaxVariable",
	attr: "syntaxVariable",
	literal: "syntaxOperator",
	operator: "syntaxOperator",
	number: "syntaxNumber",
	type: "syntaxType",
	class: "syntaxType",
	punctuation: "syntaxPunctuation",
	"selector-tag": "syntaxPunctuation",
};

function unescapeHtml(text: string): string {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&#x27;/g, "'");
}

/** Highlight a PowerShell command line, returning one ANSI-colored string per line. */
export function highlightPowerShell(code: string, theme: Theme): string[] {
	const highlightedHtml = hljs.highlight(code, { language: "powershell", ignoreIllegals: true }).value;

	const lines: string[] = [];
	let currentLine = "";
	const colorStack: string[] = [];

	const emitText = (text: string) => {
		if (!text) return;
		const parts = text.split("\n");
		for (let i = 0; i < parts.length; i++) {
			if (i > 0) {
				lines.push(currentLine);
				currentLine = "";
			}
			const part = parts[i];
			if (part) {
				const unescaped = unescapeHtml(part);
				const currentColor = colorStack[colorStack.length - 1];
				if (currentColor && typeof theme.fg === "function") {
					currentLine += theme.fg(currentColor, unescaped);
				} else {
					currentLine += unescaped;
				}
			}
		}
	};

	const tagRegex = /<span class="hljs-([^"]+)">|<\/span>/g;
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = tagRegex.exec(highlightedHtml)) !== null) {
		const chunk = highlightedHtml.slice(lastIndex, match.index);
		if (chunk) {
			emitText(chunk);
		}

		if (match[0].startsWith("<span")) {
			const cls = match[1]!;
			const color = HLJS_TO_THEME_COLOR[cls] || "";
			colorStack.push(color);
		} else {
			colorStack.pop();
		}
		lastIndex = tagRegex.lastIndex;
	}

	const tail = highlightedHtml.slice(lastIndex);
	if (tail) {
		emitText(tail);
	}

	lines.push(currentLine);
	return lines;
}
// ---------------------------------------------------------------------------
// Eval-style frame builders: titled top bar, tee divider with label, rows,
// bottom bar. Mirrors the built-in eval/bash rendering (`╭─── Title ───╮`,
// `├─── Output ───┤`) within the extension's duck-typed component limits.
// ---------------------------------------------------------------------------

/**
 * Inner frame width. One column shorter than the maximum so the closing tee /
 * corner survives width math: box-drawing glyphs (U+2500-U+257F) are
 * Ambiguous-width, and some width engines count them as 2 columns.
 */
function frameInnerWidth(width: number): number {
	return Math.max(10, width - 3);
}

/**
 * `╭─── {title} ────────────────────╮`
 * Border glyphs are colored independently so ANSI inside `title` (icon/status
 * colors) cannot reset the frame color mid-line.
 */
function frameTop(width: number, theme: Theme, title: string): string {
	const br = theme.boxRound;
	const h = br?.horizontal ?? "-";
	const inner = frameInnerWidth(width);
	const titleLen = visibleLength(title);
	const fill = Math.max(0, inner - 5 - titleLen);
	const cornerL = theme.fg("border", br?.topLeft ?? "+");
	const cornerR = theme.fg("border", br?.topRight ?? "+");
	const prefix = theme.fg("border", `${h}${h}${h} `);
	const hline = theme.fg("border", h.repeat(fill));
	return `${cornerL}${prefix}${title} ${hline}${cornerR}`;
}

/**
 * `├─── {label} ────────────────────┤`
 * NOTE: omp's symbol table names tees from the glyph's own direction
 * (teeLeft = `┤`, teeRight = `├`), so left border uses `teeRight` and vice
 * versa. Tees and filler share one ANSI segment per side so terminal width
 * handling can never drop the closing tee.
 */
function frameDivider(width: number, theme: Theme, label: string): string {
	const bs = theme.boxSharp;
	const h = theme.boxRound?.horizontal ?? bs?.horizontal ?? "-";
	const teeL = bs?.teeRight ?? "├";
	const teeR = bs?.teeLeft ?? "┤";
	const inner = frameInnerWidth(width);
	const labelLen = visibleLength(label);
	const fill = Math.max(0, inner - 5 - labelLen);
	const left = theme.fg("border", `${teeL}${h}${h}${h} `);
	const right = theme.fg("border", `${h.repeat(fill)}${teeR}`);
	return `${left}${label} ${right}`;
}

/** `│ content (padded) │` - one content row inside the frame. */
function frameRow(content: string, width: number, theme: Theme): string {
	const br = theme.boxRound;
	const v = theme.fg("border", br?.vertical ?? "|");
	const inner = frameInnerWidth(width);
	const sliced = ansiSafeSlice(content, inner - 2);
	const pad = Math.max(0, inner - 2 - visibleLength(sliced));
	return `${v} ${sliced}${" ".repeat(pad)} ${v}`;
}

/** `╰────────────────────────╯` */
function frameBottom(width: number, theme: Theme): string {
	const br = theme.boxRound;
	const h = br?.horizontal ?? "-";
	const inner = frameInnerWidth(width);
	return theme.fg("border", `${br?.bottomLeft ?? "+"}${h.repeat(inner)}${br?.bottomRight ?? "+"}`);
}

/** Language icon for the title bar - nerd-font PowerShell glyph (nf-md-powershell). */
function langIcon(): string {
	return "\u{E86C}";
}

/** Titled bar text: accent icon + bright toolTitle text. */
function frameTitle(theme: Theme, cwd?: string, extra?: string): string {
	const body = ` • PowerShell${cwd ? ` · ${cwd}` : ""}${extra ?? ""}`;
	return `${theme.fg("accent", langIcon())}${theme.fg("toolTitle", body)}`;
}

const PREVIEW_LINES_COLLAPSED = 6;
const PREVIEW_LINES_EXPANDED = 20;

interface PwshRenderResult {
	details?: PwshDetails;
	isError?: boolean;
}

interface PwshRenderOptions {
	expanded?: boolean;
	spinnerFrame?: number;
}

/** Status icon + label for the divider line (exit-code aware). */
function renderStatusLabel(d: PwshDetails, isError: boolean, theme: Theme): string {
	if (d.streaming) {
		return `${theme.fg("accent", "●")} running · Wall: ${(d.wallTimeMs / 1000).toFixed(2)}s | Timeout: ${d.timeoutSec}s`;
	}
	const exitBad = d.exitCode !== null && d.exitCode !== undefined && d.exitCode !== 0;
	const bad = isError || exitBad;
	const icon = d.dead ? "✕" : d.timedOut ? "⏱" : bad ? "✗" : "✓";
	const state = d.dead ? "process died" : d.timedOut ? "timed out" : bad ? "error" : "completed";
	const color = d.dead ? "error" : d.timedOut ? "warning" : bad ? "error" : "success";
	const exitText =
		d.exitCode !== null && d.exitCode !== undefined && d.exitCode !== 0 ? ` · exit ${d.exitCode}` : "";
	return `${theme.fg(color, icon)} ${state}${exitText} · Wall: ${(d.wallTimeMs / 1000).toFixed(2)}s | Timeout: ${d.timeoutSec}s`;
}

/**
 * Command block rows: wrapped highlighted command lines, up to four source lines.
 * Shared by renderCall and renderResult (pending + merged frames).
 * `closed: false` leaves the frame open (no bottom bar) so a merged
 * renderResult can follow with the status divider + output + single bottom.
 */
function commandBlock(
	theme: Theme,
	width: number,
	command: string,
	cwd: string | undefined,
	running: boolean,
	closed = true,
): string[] {
	const title = frameTitle(theme, cwd, running ? " · executing…" : "");
	const out: string[] = [frameTop(width, theme, title)];
	let highlighted: string[];
	try {
		highlighted = highlightPowerShell(command, theme).slice(0, 4);
	} catch {
		highlighted = command.split("\n").slice(0, 4);
	}
	const maxCommandWidth = Math.max(1, frameInnerWidth(width) - 2);
	for (const line of highlighted) {
		for (const wrapped of wrapAnsiLine(line, maxCommandWidth)) out.push(frameRow(wrapped, width, theme));
	}
	if (closed) out.push(frameBottom(width, theme));
	return out;
}

function renderBody(d: PwshDetails, expanded: boolean, theme: Theme, width: number): string[] {
	// Normalize CRLF: pwsh emits \r\n frames that would make the terminal
	// cursor jump back to line start (blank-looking rows).
	const body = (d.error ?? d.output ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!body) return [];
	const maxLines = expanded ? PREVIEW_LINES_EXPANDED : PREVIEW_LINES_COLLAPSED;
	// Out-String pads leading/trailing blank lines (CRLF frames); trim both
	// ends and collapse interior blank runs so the preview is compact.
	const raw = body.split("\n");
	while (raw.length > 0 && raw[0]!.trim() === "") raw.shift();
	while (raw.length > 0 && raw[raw.length - 1]!.trim() === "") raw.pop();
	const bodyLines: string[] = [];
	let prevBlank = false;
	const maxBodyWidth = Math.max(1, frameInnerWidth(width) - 2);
	for (const line of raw) {
		const blank = line.trim() === "";
		if (blank && prevBlank) continue;
		prevBlank = blank;
		bodyLines.push(...wrapAnsiLine(line, maxBodyWidth));
	}
	const lines = bodyLines.slice(0, maxLines);
	if (bodyLines.length > maxLines) {
		lines.push(theme.fg("dim", `… ${bodyLines.length - maxLines} more lines (ctrl+o to expand)`));
	}
	return lines;
}

export function definePwshTool(pi: ExtensionAPI) {
	const z = pi.zod;

	return {
		name: "pwsh",
		label: "PowerShell 7",
		description:
			"Execute commands in a persistent PowerShell 7 session. Modules/variables/cwd persist across calls (Import-Module is paid once). Supports text (Out-String) and JSON (ConvertTo-Json) output formats.",
		// Merge call+result into one frame like built-in tools: the pending call
		// renders the command block; once the result lands the same slot redraws
		// as the full frame (status title + command + output). Read by
		// ToolExecutionComponent via the wrapper proxy (tool-execution.ts:1012).
		mergeCallAndResult: true as boolean,
		parameters: z.object({
			command: z.string().describe("PowerShell script to execute (multi-line / script blocks supported)"),
			cwd: z.string().optional().describe("working directory; Set-Location inside the session may drift"),
			env: z.object({ "[string]": z.string() }).optional().describe("extra environment variables (restored after execution)"),
			format: z.enum(["text", "json"]).optional().describe("text=Out-String (default); json=ConvertTo-Json -Depth 100"),
			width: z.number().optional().describe("Out-String width, default 200, range 40-4096"),
			timeout: z.number().optional().describe(`timeout in seconds; 0 disables; default ${DEFAULT_TIMEOUT_SEC}; range ${MIN_TIMEOUT_SEC}-${MAX_TIMEOUT_SEC}`),
			session: z.string().optional().describe("custom session name to isolate the process pool"),
		}),
		async execute(
			_toolCallId: string,
			params: PwshParams,
			signal: AbortSignal | undefined,
			onUpdate: ((update: { content: Array<{ type: "text"; text: string }> }) => void) | undefined,
		) {
			const pool = getPool();
			const out = await runPwsh(params, pool, onUpdate, signal);
			const content = [{ type: "text" as const, text: out.text }];
			return { content, details: out.details, isError: out.isError };
		},
		onSession(event: { reason: string }): void {
			// Session lifecycle cleanup: kill pwsh subprocesses on shutdown so no
			// orphan processes survive the omp session.
			if (event.reason === "shutdown") {
				getPool().disposeAll();
			}
		},
		renderCall(args: PwshParams, options: PwshRenderOptions, theme: Theme) {
			return {
				render: (width: number) =>
					commandBlock(theme, width, args.command ?? "", args.cwd, options.spinnerFrame !== undefined),
			};
		},
		renderResult(
			result: PwshRenderResult,
			options: PwshRenderOptions,
			theme: Theme,
			args?: PwshParams,
		) {
			const d = result.details;
			if (!d) {
				// Partial/pending result (onUpdate fired, no details yet): keep the
				// command block visible instead of an empty frame.
				return {
					render: (width: number) =>
						commandBlock(theme, width, args?.command ?? "", args?.cwd, options.spinnerFrame !== undefined),
				};
			}
			const expanded = options.expanded === true;
			const statusLabel = renderStatusLabel(d, result.isError === true, theme);
			return {
				render: (width: number) => {
					const bodyLines = renderBody(d, expanded, theme, width);
					// Command block (merged frame, like built-in tools) - left open
					// so the status divider + output rows share one frame with a
					// single bottom bar.
					const out = commandBlock(theme, width, args?.command ?? "", d.cwd, false, false);
					// Status + timing divider
					out.push(frameDivider(width, theme, statusLabel));
					// Output rows
					for (const l of bodyLines) out.push(frameRow(l, width, theme));
					if (expanded && d.dead) {
						out.push(frameRow(theme.fg("dim", "session reset; will be rebuilt on next call"), width, theme));
					}
					out.push(frameBottom(width, theme));
					return out;
				},
			};
		},
	};
}

// Module-level pool so the tool keeps sessions across calls within the process.
let pool: PwshSessionPool | null = null;
function getPool(): PwshSessionPool {
	if (!pool) pool = new PwshSessionPool();
	return pool;
}
