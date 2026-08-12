/**
 * `pwsh` - persistent PowerShell 7 session tool for OMP.
 *
 * One long-lived `pwsh -File runner.ps1` subprocess per (cwd, session) key.
 * State (variables, modules, location) survives across calls, so module
 * imports are paid once. Protocol and runner live in `session.ts`/`runner.ps1`.
 */
import * as fs from "node:fs";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { PwshSessionPool, type PwshRunResult } from "./session";

const DEFAULT_TIMEOUT_SEC = 120;
const MIN_TIMEOUT_SEC = 1;
const MAX_TIMEOUT_SEC = 3600;
const DEFAULT_WIDTH = 200;
const MIN_WIDTH = 40;
const MAX_WIDTH = 4096;

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
	error?: string | null;
	output?: string | null;
	wallTimeMs: number;
}

interface SessionLike {
	run(req: { code: string; env?: Record<string, string>; width?: number; format?: "text" | "json" }, opts: { timeoutMs?: number; signal?: AbortSignal }): Promise<PwshRunResult>;
}

interface PwshApi {
	getOrCreate(key: string, cwd?: string): SessionLike;
}

/** Session key: cwd + explicit session name. */
export function buildSessionKey(cwd: string, session?: string): string {
	return `${cwd}\n${session ?? ""}`;
}

/** Core execute body - split out for smoke tests. */
export async function runPwsh(
	params: PwshParams,
	api: PwshApi,
	onUpdate?: (update: { content: Array<{ type: "text"; text: string }> }) => void,
	signal?: AbortSignal,
): Promise<{ text: string; details: PwshDetails; isError?: boolean }> {
	const started = Date.now();
	const command = params.command;
	const cwd = params.cwd ?? process.cwd();
	onUpdate?.({ content: [{ type: "text", text: `[pwsh] running in session ${buildSessionKey(cwd, params.session)}…` }] });

	// Validate cwd before spawning so a bad path fails fast instead of
	// producing a confusing spawn error.
	let cwdStat: fs.Stats;
	try {
		cwdStat = await fs.promises.stat(cwd);
	} catch {
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

	const runResult = await session.run(
		{
			code: command,
			env: params.env,
			width,
			format,
		},
		{ timeoutMs: timeoutSec === 0 ? undefined : timeoutSec * 1000, signal },
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
	while (i < text.length && visible < max) {
		if (text[i] === "\x1b") {
			const end = text.indexOf("m", i);
			if (end === -1) {
				out += text.slice(i);
				break;
			}
			out += text.slice(i, end + 1);
			i = end + 1;
		} else {
			const w = charWidth(text[i]!);
			if (visible + w > max) break;
			out += text[i]!;
			visible += w;
			i++;
		}
	}
	if (i < text.length) out += "…";
	return out;
}

// ---------------------------------------------------------------------------
// Lightweight PowerShell syntax highlighter.
//
// The native highlighter (pi-natives 17.2.15) advertises powershell/ps1 via
// its alias table but ships no PowerShell syntax, so highlightCode() returns
// plain text for it. This tokenizer covers the common surface (strings,
// comments, variables, keywords, cmdlets, operators, numbers) with theme
// syntax colors; swap for the native path when upstream bundles the grammar.
// ---------------------------------------------------------------------------

const PS_KEYWORDS: Record<string, true> = {
	if: true, else: true, elseif: true, foreach: true, for: true, while: true,
	do: true, until: true, switch: true, function: true, filter: true, param: true,
	return: true, break: true, continue: true, try: true, catch: true, finally: true,
	throw: true, begin: true, process: true, end: true, class: true, enum: true,
	module: true, using: true, exit: true, in: true, not: true, and: true, or: true,
	eq: true, ne: true, gt: true, lt: true, ge: true, le: true, true: true, false: true,
	null: true, new: true, global: true, script: true, local: true, private: true,
};

const PS_TOKEN_RE =
	/('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|#[^\n]*|\$[A-Za-z_][A-Za-z0-9_]*|\$\{[^}\n]+\}|[A-Za-z][A-Za-z0-9]*-(?:[A-Za-z][A-Za-z0-9]*)?|-[A-Za-z]{1,4}\b|\d+(?:\.\d+)?|[|&;(){}\[\],=+*/%<>])/g;

type PsTokenKind = "string" | "comment" | "variable" | "keyword" | "cmdlet" | "operator" | "number" | "punct";

function classifyPsToken(tok: string): PsTokenKind {
	if (tok.startsWith("'") || tok.startsWith('"')) return "string";
	if (tok.startsWith("#")) return "comment";
	if (tok.startsWith("$") || tok.startsWith("${")) return "variable";
	if (/^-{1,2}[a-z]+$/i.test(tok) || /^[|&<>=+*/%]+$/.test(tok)) return "operator";
	if (/^\d/.test(tok)) return "number";
	const lower = tok.toLowerCase();
	if (PS_KEYWORDS[lower] === true) return "keyword";
	// PascalCase verb-noun (cmdlet) or a bare command word
	if (/^[A-Z][A-Za-z0-9]*-[A-Za-z]/.test(tok) || /^[A-Za-z][A-Za-z0-9]*$/.test(tok)) return "cmdlet";
	return "punct";
}

const PS_TOKEN_COLOR: Record<PsTokenKind, string> = {
	string: "syntaxString",
	comment: "syntaxComment",
	variable: "syntaxVariable",
	keyword: "syntaxKeyword",
	cmdlet: "syntaxFunction",
	operator: "syntaxOperator",
	number: "syntaxNumber",
	punct: "syntaxPunctuation",
};

/** Highlight a PowerShell command line, returning one ANSI-colored string per line. */
function highlightPowerShell(code: string, theme: Theme): string[] {
	const out: string[] = [];
	for (const line of code.split("\n")) {
		let result = "";
		let last = 0;
		PS_TOKEN_RE.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = PS_TOKEN_RE.exec(line)) !== null) {
			const start = m.index;
			if (start > last) result += line.slice(last, start);
			const tok = m[0]!;
			const kind = classifyPsToken(tok);
			const color = PS_TOKEN_COLOR[kind];
			result += typeof theme.fg === "function" ? theme.fg(color, tok) : tok;
			last = start + tok.length;
		}
		if (last < line.length) result += line.slice(last);
		out.push(result);
	}
	return out;
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
 * Command block rows: titled frame with up to 4 highlighted command lines.
 * Shared by renderCall and renderResult (pending + merged frames).
 */
function commandBlock(
	theme: Theme,
	width: number,
	command: string,
	cwd: string | undefined,
	running: boolean,
): string[] {
	const title = frameTitle(theme, cwd, running ? " · executing…" : "");
	const out: string[] = [frameTop(width, theme, title)];
	let highlighted: string[];
	try {
		highlighted = highlightPowerShell(command, theme).slice(0, 4);
	} catch {
		highlighted = command.split("\n").slice(0, 4);
	}
	for (const l of highlighted) out.push(frameRow(l, width, theme));
	out.push(frameBottom(width, theme));
	return out;
}

function renderBody(d: PwshDetails, expanded: boolean, theme: Theme): string[] {
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
	for (const l of raw) {
		const blank = l.trim() === "";
		if (blank && prevBlank) continue;
		prevBlank = blank;
		bodyLines.push(l);
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
			"cwd?": z.string().optional().describe("working directory; Set-Location inside a command may drift"),
			"env?": z.object({ "[string]": z.string() }).optional().describe("extra environment variables (restored after execution)"),
			"format?": z.enum(["text", "json"]).optional().describe("text=Out-String (default); json=ConvertTo-Json -Depth 8"),
			"width?": z.number().optional().describe("Out-String width, default 200, range 40-4096"),
			"timeout?": z.number().optional().describe(`timeout in seconds; 0 disables; default ${DEFAULT_TIMEOUT_SEC}; range ${MIN_TIMEOUT_SEC}-${MAX_TIMEOUT_SEC}`),
			"session?": z.string().optional().describe("custom session name to isolate the process pool"),
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
			const bodyLines = renderBody(d, expanded, theme);
			return {
				render: (width: number) => {
					// Command block (merged frame, like built-in tools)
					const out = commandBlock(theme, width, args?.command ?? "", d.cwd, false);
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
