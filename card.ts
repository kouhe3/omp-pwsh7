/**
 * Card rendering for the `pwsh` tool: the rows drawn inside the host's
 * custom-tool box, the one-row pending line, and the title/status text they
 * share.
 *
 * Split out of `pwsh-tool.ts` so the tool definition stays about execution.
 *
 * The render hooks return a rows object, not a component: omp boxes those rows
 * itself (one blank row above and below, one cell of padding, the call's state
 * tint) but draws no border and no head, so a card here draws its own frame,
 * title and body rows. Widths and ANSI handling come from the host's own text
 * engine (`@oh-my-pi/pi-tui/text/width`), the same one that measures the box
 * the rows land in.
 */
import * as os from "node:os";
import * as path from "node:path";
import {
  replaceTabs,
  truncate,
  visibleWidth,
  wrap,
} from "@oh-my-pi/pi-tui/text/width";
import type { PwshDetails } from "./pwsh-tool";
import { sanitizeTerminalText } from "./sanitize";
import { highlightPowerShell } from "./syntax";

/**
 * The visible counterpart of bash's steer notice: a steering message detached
 * this call into a background job while the command keeps running.
 */
export const STEERED_NOTICE =
  "Backgrounded early to handle an incoming message; the command keeps running.";

/**
 * What the card needs from the extension theme: the pi-tui `Theme` (`fg`,
 * `symbols`) is structurally assignable, and a test double only has to carry
 * `fg`.
 */
export interface Theme {
  fg(color: string, text: string): string;
  symbols?: {
    symbol(key: string): string;
    langIcon?(lang: string | undefined): string;
  };
}

/**
 * Glyph of a theme symbol key, else `fallback`: `symbol` answers `""` for a key
 * a theme leaves out, and an ascii symbol preset has no icons at all.
 */
function glyph(theme: Theme, key: string, fallback: string): string {
  return theme.symbols?.symbol(key) || fallback;
}

/** The `·` that separates a row's parts (`sep.dot` carries its own spaces). */
function dot(theme: Theme): string {
  return theme.symbols?.symbol("sep.dot") || " · ";
}

/** Fallback glyphs of the status keys, matching the unicode symbol preset. */
const STATUS_FALLBACKS = {
  success: "✔",
  error: "✘",
  warning: "⚠",
  running: "⟳",
  aborted: "⏹",
  pending: "⏳",
} as const;

type StatusName = keyof typeof STATUS_FALLBACKS;

/** Status glyph by name (`status.<name>`), themed like the host's own cards. */
function statusGlyph(theme: Theme, name: StatusName): string {
  return glyph(theme, `status.${name}`, STATUS_FALLBACKS[name]);
}

/** Tool label: the card's fallback title and the tool's registered `label`. */
export const TOOL_LABEL = "PowerShell 7";

/**
 * A leading home directory shortened to `~`, separators normalized — the form
 * the host's own tool cards give a path outside the project.
 */
function shortenHome(target: string): string {
  const home = os.homedir();
  if (!home || home.length <= 1) return target;
  const windowsStyle = /^[A-Za-z]:[\\/]/.test(home) || home.startsWith("\\\\");
  // A trailing separator (`C:\Users\me\`, `/home/me/`) must still match
  // `<home>/child`; roots such as `/` and `C:\` keep theirs.
  const trimmed = home.replace(/(?<=[^\\/:])[\\/]+$/, "");
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const leading = new RegExp(`^${escaped}(?=$|[\\\\/])`, windowsStyle ? "i" : "");
  const match = leading.exec(target);
  if (!match) return target;
  const suffix = target.slice(match[0].length);
  return `~${suffix.replaceAll(path.win32.sep, path.posix.sep)}`;
}

/**
 * A working directory as the card's title shows it, the rule the built-in
 * tool cards use: nothing when it resolves to the session directory, a
 * relative path inside the project, a `~`-shortened absolute one outside.
 *
 * Local because the host's `formatToolWorkingDirectory` (and the pi-tui module
 * that carried it) is gone in 19.2; the rule is the same one
 * `ui/tools/run.tsx` uses for its own cards.
 */
export function formatWorkingDirectory(
  workdir: string | undefined,
  projectDir: string,
): string | undefined {
  if (!workdir) return undefined;
  const root = path.resolve(projectDir);
  const resolved = path.resolve(projectDir, workdir);
  if (resolved === root) return undefined;
  const relative = path.relative(root, resolved);
  // On Windows, `path.relative` across drives returns the absolute target,
  // which is not inside the project.
  const inside =
    relative.length > 0 &&
    !path.isAbsolute(relative) &&
    !relative.startsWith("..");
  return replaceTabs(inside ? relative : shortenHome(resolved));
}

/** Icon ahead of a card's title: the theme's PowerShell icon. */
function titleIcon(theme: Theme): string {
  return (
    theme.symbols?.langIcon?.("powershell") ||
    theme.symbols?.symbol("lang.shell") ||
    "⌘"
  );
}

/**
 * The card's title row: accent icon + bright title, plus the working directory
 * the call asked for.
 *
 * The title is the model's intent, not the tool name, and `cwd` is only shown
 * when the call asked for one — the session cwd is implied, and printing it on
 * every card both repeats itself and eats the header's width budget.
 */
function titleRow(theme: Theme, label: string, cwd?: string): string {
  const safeLabel = sanitizeTerminalText(label);
  const safeCwd = cwd ? sanitizeTerminalText(cwd) : "";
  const body = `${safeLabel}${safeCwd ? `${dot(theme)}${safeCwd}` : ""}`;
  return `${theme.fg("accent", titleIcon(theme))} ${theme.fg("toolTitle", body)}`;
}

/**
 * One-line, control-free form of a model-authored intent.
 *
 * Whitespace runs collapse to one space: a newline inside a rendered row splits
 * the card in the terminal. Control sequences are stripped because `i` and
 * `jobId` are model-authored, so a raw ESC here reaches the terminal unfiltered
 * (see `sanitizeTerminalText`).
 */
export function oneLineIntent(intent: unknown): string {
  return typeof intent === "string"
    ? sanitizeTerminalText(intent).replace(/\s+/g, " ").trim()
    : "";
}

/**
 * Title text a call declares itself: the model's intent, else the job-control
 * action, else the tool label.
 *
 * `i` comes from the *streamed* tool-call JSON, which can carry a non-string
 * (number/object/boolean) before schema validation — the host guards for this at
 * its own callsite. `?.` alone would throw `args.i.trim is not a function`, and a
 * throwing renderer makes the host substitute a bare label line.
 */
function callLabel(args: {
  i?: unknown;
  jobId?: unknown;
  action?: unknown;
}): string {
  const intent = oneLineIntent(args.i);
  if (intent.length > 0) return intent;
  if (typeof args.jobId === "string" && args.jobId.trim().length > 0) {
    const cleanJobId = sanitizeTerminalText(args.jobId)
      .replace(/\s+/g, " ")
      .trim();
    if (args.action === "kill") return `Kill job ${cleanJobId}`;
    if (args.action === "wait") return `Wait job ${cleanJobId}`;
    return `Job status ${cleanJobId}`;
  }
  return TOOL_LABEL;
}

/**
 * Intent seen for one call, keyed by its args object.
 *
 * The host hands `renderResult` the live args object, so a card built there can
 * still read an intent the streamed arguments carried (intent tracing strips `i`
 * from the parameters `execute` sees, not from the object the renderers get).
 * `renderCall` is handed a clone, which this map misses on purpose — the clone
 * keeps `i` itself, and `tool_execution_start` covers the case where it does
 * not (see `intentsByCallId` in `pwsh-tool.ts`).
 */
const intentsByArgs = new WeakMap<object, string>();

/** Record the intent declared for one call's args object (see `intentsByArgs`). */
export function rememberIntent(args: unknown, intent: unknown): void {
  const clean = oneLineIntent(intent);
  if (clean.length === 0 || typeof args !== "object" || args === null) return;
  intentsByArgs.set(args, clean);
}

/** Intent already recorded for one call's args object, if any. */
function recordedIntent(args: unknown): string | undefined {
  return typeof args === "object" && args !== null
    ? intentsByArgs.get(args)
    : undefined;
}

/** Title for one card: the args' own intent, else the recorded one, else the tool label. */
export function callTitle(
  args: { i?: unknown; jobId?: unknown; action?: unknown } | undefined,
): string {
  const fromArgs = callLabel(args ?? {});
  if (fromArgs !== TOOL_LABEL) {
    rememberIntent(args, fromArgs);
    return fromArgs;
  }
  return recordedIntent(args) ?? TOOL_LABEL;
}

/**
 * One-row pending line, drawn while the model is still emitting the arguments:
 * a single row, no card body, the shape the host's inline tools use — the box
 * around it (padding, tint) is the host's job for every rows renderer.
 */
export function renderPendingRow(theme: Theme, label: string): string {
  const icon = theme.fg("muted", statusGlyph(theme, "pending"));
  return `${icon} ${theme.fg("toolTitle", sanitizeTerminalText(label))}`;
}

const PREVIEW_LINES_COLLAPSED = 6;

const PREVIEW_LINES_EXPANDED = 20;

export interface PwshRenderResult {
  details?: PwshDetails;
  isError?: boolean;
}

export interface PwshRenderOptions {
  expanded?: boolean;
  isPartial?: boolean;
  /**
   * False while the model is still emitting the tool-call arguments. The host
   * reports this to `renderCall`; the card stays a one-row pending line until it
   * flips, so a half-streamed command never draws a card.
   */
  argsComplete?: boolean;
}

/**
 * ` [jobId]` tag for a running/killed job: control-free and single-line, so a
 * model-authored id cannot break the status row it is drawn into.
 */
function jobTag(jobId: string | undefined): string {
  if (!jobId) return "";
  return ` [${sanitizeTerminalText(jobId).replace(/\s+/g, " ").trim()}]`;
}

/** Status row: icon + state, exit code, timing and job id (state-aware). */
function renderStatusLabel(
  d: PwshDetails,
  isError: boolean,
  theme: Theme,
  isPartial = false,
): string {
  const state = (name: StatusName, color: string, text: string): string =>
    `${theme.fg(color, statusGlyph(theme, name))} ${text}`;
  // A progress frame can arrive before the runner reported a wall time: an
  // unknown clock reads `0.00s`, not `NaNs`.
  const wall = Number.isFinite(d.wallTimeMs)
    ? (d.wallTimeMs / 1000).toFixed(2)
    : "0.00";
  const timing = `Wall: ${wall}s | Timeout: ${d.timeoutSec}s`;
  if (d.async && d.status === "running") {
    return state("running", "accent", `running${jobTag(d.jobId)}`);
  }
  if (d.status === "killed") {
    return state("aborted", "error", `killed${jobTag(d.jobId)}`);
  }
  if (d.cancelled) {
    return state("aborted", "error", `cancelled${jobTag(d.jobId)}`);
  }
  if (isPartial || d.streaming) {
    return state("running", "accent", `running${dot(theme)}${timing}`);
  }
  const hasExitCode = d.exitCode != null && d.exitCode !== 0;
  const isFailed = d.status === "failed";
  const bad = isError || hasExitCode || isFailed;
  const name: StatusName = d.dead
    ? "error"
    : d.timedOut
      ? "warning"
      : bad
        ? "error"
        : "success";
  const label = d.dead
    ? "process died"
    : d.timedOut
      ? "timed out"
      : isFailed
        ? "failed"
        : bad
          ? "error"
          : "completed";
  const color = d.dead
    ? "error"
    : d.timedOut
      ? "warning"
      : bad
        ? "error"
        : "success";
  const exitText = hasExitCode ? `${dot(theme)}exit ${d.exitCode}` : "";
  return state(name, color, `${label}${exitText}${dot(theme)}${timing}`);
}

/** Command source lines shown before collapsing behind a ctrl+o hint. */
const COMMAND_PREVIEW_LINES = 4;

/** Options shared by the call, result and preview card builders. */
export interface PwshFrameOptions {
  /** Title label: the model's intent, or the tool label when it declared none. */
  label?: string;
  /**
   * Working directory the call asked for, exactly as the model passed it. The
   * title shows {@link formatWorkingDirectory}'s form: nothing when it resolves
   * to the session directory, a relative path inside the project, a shortened
   * absolute path outside — the rule the built-in bash card uses.
   */
  cwd?: string;
  /** `false` leaves the frame open for a merged result to close it. */
  closed?: boolean;
  expanded?: boolean;
}

/** Wrap one (possibly ANSI-colored) line, keeping blank lines as one row. */
function wrapLines(text: string, width: number): string[] {
  const rows = wrap(text, Math.max(1, width));
  return rows.length > 0 ? rows : [""];
}

/** Drop a submitted command's trailing newlines: not command lines. */
function trimTrailingBlank(lines: string[]): string[] {
  const out = [...lines];
  while (out.length > 1 && out[out.length - 1]!.trim() === "") out.pop();
  return out;
}

// ---------------------------------------------------------------------------
// Frame builders: titled top bar, tee divider with the status, rows, bottom
// bar — the card the extension drew before the rows migration, now drawn by
// the rows renderer itself. The host boxes those rows with padding and a state
// tint but draws no border, so without this a finished call reads as a
// borderless block.
// ---------------------------------------------------------------------------

/** Border color: the one the host's own boxed cards use. */
const BORDER = "borderMuted";

/** Box glyph of a theme symbol key, else `fallback`. */
function boxGlyph(theme: Theme, key: string, fallback: string): string {
  return theme.symbols?.symbol(key) || fallback;
}

/**
 * Inner span of the frame's horizontal bars. One column narrower than the
 * maximum so the closing corner survives width math: box-drawing glyphs are
 * Ambiguous-width, and some width engines count them as two columns.
 */
function frameInnerWidth(width: number): number {
  return Math.max(10, width - 3);
}

/** `╭─── {title} ────────────────────╮` */
function frameTop(theme: Theme, width: number, title: string): string {
  const h = boxGlyph(theme, "boxRound.horizontal", "─");
  const inner = frameInnerWidth(width);
  // Three leader dashes, their trailing space, the space after the title and
  // the two corners consume five columns; clamping the title (rather than
  // letting the fill floor at 0) keeps a long, model-authored intent inside
  // the frame it drew.
  const shown = truncate(title, Math.max(1, inner - 5), "…");
  const fill = Math.max(0, inner - 5 - visibleWidth(shown));
  const cornerL = theme.fg(BORDER, boxGlyph(theme, "boxRound.topLeft", "╭"));
  const cornerR = theme.fg(BORDER, boxGlyph(theme, "boxRound.topRight", "╮"));
  return `${cornerL}${theme.fg(BORDER, `${h}${h}${h} `)}${shown} ${theme.fg(BORDER, `${h.repeat(fill)}${cornerR}`)}`;
}

/** `├─── {label} ────────────────────┤` */
function frameDivider(theme: Theme, width: number, label: string): string {
  const h = boxGlyph(theme, "boxRound.horizontal", "─");
  const inner = frameInnerWidth(width);
  // omp names tees from the glyph's own direction (teeRight = `├`), so the
  // left border takes `teeRight` and the right one `teeLeft`.
  const teeL = boxGlyph(theme, "boxSharp.teeRight", "├");
  const teeR = boxGlyph(theme, "boxSharp.teeLeft", "┤");
  const shown = truncate(label, Math.max(1, inner - 5), "…");
  const fill = Math.max(0, inner - 5 - visibleWidth(shown));
  return `${theme.fg(BORDER, `${teeL}${h}${h}${h} `)}${shown} ${theme.fg(BORDER, `${h.repeat(fill)}${teeR}`)}`;
}

/** `│ content (padded) │` — one content row inside the frame. */
function frameRow(theme: Theme, width: number, content: string): string {
  const room = Math.max(1, frameInnerWidth(width) - 2);
  const shown = truncate(content, room, "");
  const pad = Math.max(0, room - visibleWidth(shown));
  const v = theme.fg(BORDER, boxGlyph(theme, "boxRound.vertical", "│"));
  return `${v} ${shown}${" ".repeat(pad)} ${v}`;
}

/** `╰────────────────────────╯` */
function frameBottom(theme: Theme, width: number): string {
  const h = boxGlyph(theme, "boxRound.horizontal", "─");
  const cornerL = boxGlyph(theme, "boxRound.bottomLeft", "╰");
  const cornerR = boxGlyph(theme, "boxRound.bottomRight", "╯");
  return theme.fg(BORDER, `${cornerL}${h.repeat(frameInnerWidth(width))}${cornerR}`);
}

/** `╰─── status ────────────────────╯` */
function frameBottomWithStatus(
  theme: Theme,
  width: number,
  label: string,
): string {
  const h = boxGlyph(theme, "boxRound.horizontal", "─");
  const inner = frameInnerWidth(width);
  const cornerL = boxGlyph(theme, "boxRound.bottomLeft", "╰");
  const cornerR = boxGlyph(theme, "boxRound.bottomRight", "╯");
  const shown = truncate(label, Math.max(1, inner - 5), "…");
  const fill = Math.max(0, inner - 5 - visibleWidth(shown));
  return `${theme.fg(BORDER, `${cornerL}${h}${h}${h} `)}${shown} ${theme.fg(BORDER, `${h.repeat(fill)}${cornerR}`)}`;
}

/**
 * Command rows: the titled top bar, then the wrapped, highlighted command
 * lines, then the bottom bar (`closed: false` leaves it open so a merged
 * result can follow with its status divider, output and a single bottom).
 * Collapsed shows the first `COMMAND_PREVIEW_LINES` source lines plus a hint
 * for the rest; expanded shows every line — multi-line scripts (here-strings,
 * script blocks) used to stop dead after line four with no indication.
 * Shared by renderCall and renderResult.
 */
export function commandBlock(
  theme: Theme,
  width: number,
  command: string,
  options: PwshFrameOptions = {},
): string[] {
  const expanded = options.expanded === true;
  const closed = options.closed !== false;
  const out: string[] = [
    frameTop(
      theme,
      width,
      titleRow(
        theme,
        options.label ?? TOOL_LABEL,
        formatWorkingDirectory(options.cwd, process.cwd()),
      ),
    ),
  ];
  // Sanitize before highlighting: `highlightPowerShell` output carries the
  // theme's own escape sequences, so only the raw source can be filtered.
  const source = sanitizeTerminalText(command);
  if (source.trim().length === 0) {
    if (closed) out.push(frameBottom(theme, width));
    return out;
  }
  let lines: string[];
  try {
    lines = trimTrailingBlank(highlightPowerShell(source, theme));
  } catch {
    lines = trimTrailingBlank(source.split("\n"));
  }
  const visibleCount = expanded
    ? lines.length
    : Math.min(lines.length, COMMAND_PREVIEW_LINES);
  const commandWidth = Math.max(1, frameInnerWidth(width) - 2);
  for (const line of lines.slice(0, visibleCount)) {
    for (const row of wrapLines(line, commandWidth)) {
      out.push(frameRow(theme, width, row));
    }
  }
  const hiddenLines = lines.length - visibleCount;
  if (hiddenLines > 0) {
    out.push(
      frameRow(
        theme,
        width,
        theme.fg("dim", `… ${hiddenLines} more lines (ctrl+o to expand)`),
      ),
    );
  }
  if (closed) out.push(frameBottom(theme, width));
  return out;
}

function renderBody(
  d: PwshDetails,
  expanded: boolean,
  theme: Theme,
  width: number,
): string[] {
  const bodyWidth = Math.max(1, frameInnerWidth(width) - 2);
  // The steering notice sits above the output and survives the empty-output
  // case: the card must say why a command that is still running stopped
  // streaming into it (bash renders the same sentence in its Output pane).
  const noticeLines = d.steered
    ? wrapLines(theme.fg("warning", STEERED_NOTICE), bodyWidth)
    : [];
  // Output and error text come from the script, not from us: strip control
  // sequences before they reach the terminal. CR is one of them, which also
  // disposes of the CRLF frames pwsh emits (they would otherwise make the
  // cursor jump back to the line start and render as blank rows).
  const body = sanitizeTerminalText(d.error ?? d.output ?? "");
  if (!body) return noticeLines;
  const maxLines = expanded ? PREVIEW_LINES_EXPANDED : PREVIEW_LINES_COLLAPSED;
  // Out-String pads leading/trailing blank lines (CRLF frames); trim both
  // ends and collapse interior blank runs so the preview is compact.
  const raw = body.split("\n");
  let start = 0;
  while (start < raw.length && raw[start]!.trim() === "") start++;
  let end = raw.length;
  while (end > start && raw[end - 1]!.trim() === "") end--;
  const trimmed = raw.slice(start, end);
  const bodyLines: string[] = [];
  let prevBlank = false;
  for (const line of trimmed) {
    const blank = line.trim() === "";
    if (blank && prevBlank) continue;
    prevBlank = blank;
    bodyLines.push(...wrapLines(line, bodyWidth));
  }
  const lines = bodyLines.slice(0, maxLines);
  if (bodyLines.length > maxLines) {
    lines.push(
      theme.fg(
        "dim",
        `… ${bodyLines.length - maxLines} more lines (ctrl+o to expand)`,
      ),
    );
  }
  return [...noticeLines, ...lines];
}

/**
 * The card's rows: one closed frame. The top bar carries the title, the command
 * rows follow, then the status — as a divider when output follows it, folded
 * into the closing bottom bar when there is none — and the output rows.
 * Called by `renderResult` in `pwsh-tool.ts`.
 */
export function renderCard(
  theme: Theme,
  width: number,
  command: string,
  details: PwshDetails,
  options: PwshRenderOptions & PwshFrameOptions & { isError?: boolean } = {},
): string[] {
  const expanded = options.expanded === true;
  const statusText = renderStatusLabel(
    details,
    options.isError === true,
    theme,
    options.isPartial === true,
  );
  const bodyLines = renderBody(details, expanded, theme, width);
  if (expanded && details.dead) {
    bodyLines.push(
      theme.fg("dim", "session reset; will be rebuilt on next call"),
    );
  }

  const hasCommand = command.trim().length > 0;
  const hasBody = bodyLines.length > 0;

  // No output (an async job start, a silent command, a kill action): the status
  // closes the card on its own bottom bar instead of a divider followed by an
  // empty body and a second bar.
  if (!hasBody) {
    const out = commandBlock(theme, width, command, {
      label: options.label,
      cwd: options.cwd,
      closed: false,
      expanded,
    });
    out.push(frameBottomWithStatus(theme, width, statusText));
    return out;
  }

  // Output but no command (a job inspection): title bar, output, status bar.
  if (!hasCommand) {
    const out = [
      frameTop(
        theme,
        width,
        titleRow(
          theme,
          options.label ?? TOOL_LABEL,
          formatWorkingDirectory(options.cwd, process.cwd()),
        ),
      ),
      ...bodyLines.map((line) => frameRow(theme, width, line)),
      frameBottomWithStatus(theme, width, statusText),
    ];
    return out;
  }

  // Command and output: title bar, command rows, status divider, output, bottom.
  const out = commandBlock(theme, width, command, {
    label: options.label,
    cwd: options.cwd,
    closed: false,
    expanded,
  });
  out.push(frameDivider(theme, width, statusText));
  for (const line of bodyLines) out.push(frameRow(theme, width, line));
  out.push(frameBottom(theme, width));
  return out;
}