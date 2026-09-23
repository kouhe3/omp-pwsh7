/**
 * Card rendering for the `pwsh` tool: the framed block, the one-row pending
 * line, and the title/status text they share.
 *
 * Split out of `pwsh-tool.ts` so the tool definition stays about execution.
 * Host-owned pi-tui instance (see `pwsh-tool.ts`): the workdir formatter has to
 * come from the module the host itself loaded, so both sides agree on the path.
 */
import { formatToolWorkingDirectory } from "@oh-my-pi/pi-tui/render";
import type { PwshDetails } from "./pwsh-tool";
import { highlightPowerShell } from "./syntax";

export interface Theme {
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

/** Column width of one code point. */
function codePointWidth(char: string): number {
  return Bun.stringWidth(char);
}

/**
 * Visible width of a possibly-ANSI-colored string, from `Bun.stringWidth` — the
 * same metric the host's TUI uses (`AGENTS.md`: "String width:
 * `Bun.stringWidth()`"). The previous hand-rolled table only covered the BMP: an
 * astral emoji measured 1 column when wrapping (code-point loop) but 2 when
 * padding (UTF-16 loop), so any row containing one came out a column wider than
 * its siblings and pushed the right border out.
 */
function visibleLength(text: string): number {
  return Bun.stringWidth(text, { countAnsiEscapeCodes: false });
}

/**
 * Slice a possibly-ANSI-colored string to `max` visible columns, preserving
 * escapes. A truncation spends one of those columns on `…`, so the result never
 * exceeds `max` — appending the ellipsis on top of a full-budget slice pushed
 * rows one column past the frame border.
 */
function ansiSafeSlice(text: string, max: number): string {
  if (max <= 0) return "";
  const budget = visibleLength(text) <= max ? max : max - 1;
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
    // Step by code point: a surrogate pair is one glyph, not two columns.
    const char = String.fromCodePoint(text.codePointAt(i) ?? 0);
    const w = codePointWidth(char);
    if (visible + w > budget) break;
    out += char;
    visible += w;
    i += char.length;
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
        if (
          params.length === 0 ||
          params.some(
            (param) => param === "0" || param === "39" || param === "49",
          )
        ) {
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
    const width = codePointWidth(char);
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
  // `╭─── {title} {fill}╮`: three leader dashes, their trailing space, the space
  // after the title and the two corners consume five columns, so this is the
  // title's budget. Clamping the title (rather than letting `fill` floor at 0)
  // is what keeps a long, model-authored intent inside the frame it drew.
  const shown = ansiSafeSlice(title, Math.max(1, inner - 5));
  const fill = Math.max(0, inner - 5 - visibleLength(shown));
  const cornerL = theme.fg("border", br?.topLeft ?? "+");
  const cornerR = theme.fg("border", br?.topRight ?? "+");
  const prefix = theme.fg("border", `${h}${h}${h} `);
  const hline = theme.fg("border", h.repeat(fill));
  return `${cornerL}${prefix}${shown} ${hline}${cornerR}`;
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
  // Same budget as the top bar (three dashes, their space, the space after the
  // label, two tees): a status label such as `✓ completed · Wall: … | Timeout:
  // 120s` is longer than a narrow frame and used to be drawn at full length.
  const shown = ansiSafeSlice(label, Math.max(1, inner - 5));
  const fill = Math.max(0, inner - 5 - visibleLength(shown));
  const left = theme.fg("border", `${teeL}${h}${h}${h} `);
  const right = theme.fg("border", `${h.repeat(fill)}${teeR}`);
  return `${left}${shown} ${right}`;
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
  return theme.fg(
    "border",
    `${br?.bottomLeft ?? "+"}${h.repeat(inner)}${br?.bottomRight ?? "+"}`,
  );
}

const LANG_ICON = "\u{E86C}";

/** Tool label: the card's fallback title and the tool's registered `label`. */
export const TOOL_LABEL = "PowerShell 7";

/**
 * Titled bar text: accent icon + bright title.
 *
 * The title is the model's intent, not the tool name, and `cwd` is only shown
 * when the call asked for one — the session cwd is implied, and printing it on
 * every card both repeats itself and eats the header's width budget.
 */
function frameTitle(theme: Theme, label: string, cwd?: string): string {
  const body = ` ${label}${cwd ? ` · ${cwd}` : ""}`;
  return `${theme.fg("accent", LANG_ICON)}${theme.fg("toolTitle", body)}`;
}

/**
 * Card title text for a call: the model's intent, falling back to the tool name.
 *
 * `i` is read from the *streamed* tool-call JSON, which can carry a non-string
 * (number/object/boolean) before schema validation — the host guards for this at
 * its own callsite. `?.` alone would throw `args.i.trim is not a function`, and a
 * throwing renderer makes the host substitute a bare label line.
 *
 * Whitespace runs collapse to one space: a model-authored intent can carry a
 * newline, and a newline inside a rendered row splits the frame in the terminal.
 * The host flattens intent text for the same reason (`renderStatusLine`).
 */
function callLabel(args: { i?: unknown }): string {
  const intent =
    typeof args.i === "string" ? args.i.replace(/\s+/g, " ").trim() : "";
  return intent.length > 0 ? intent : TOOL_LABEL;
}

/**
 * Intent seen while the args streamed, keyed by the host's render-state object:
 * one object per card, handed to both `renderCall` and `renderResult`
 * (`tool-execution.ts`, `#renderState`).
 *
 * The host reconciles the args at `tool_execution_start` with the *validated*
 * object, and intent tracing strips `i` out of it (`agent-loop.ts`:
 * `extractIntent` -> `effectiveArgs` -> `event.args`). Without this memo the
 * finished card — the one the user keeps on screen — falls back to the tool
 * label while the pending row and a rebuilt transcript both show the intent.
 */
const streamedIntents = new WeakMap<object, string>();

/** Title for one card: the args' intent while they still carry it, else the memo. */
export function callTitle(
  options: PwshRenderOptions,
  args: { i?: unknown } | undefined,
): string {
  const fromArgs = callLabel(args ?? {});
  if (fromArgs === TOOL_LABEL) return streamedIntents.get(options) ?? TOOL_LABEL;
  streamedIntents.set(options, fromArgs);
  return fromArgs;
}

/**
 * One-row pending line, drawn while the model is still emitting the arguments.
 *
 * Same shape as the host's inline tools (`grep`/`glob` render `renderStatusLine`
 * with the `pending` icon inside a `Text(text, 1, 0)`): a single row, no frame,
 * no card background. The component is marked as a framed block so the host adds
 * neither padding nor its state tint, and the leading column is ours to add —
 * exactly what `Text(..., 1, 0)` does for those built-ins.
 */
function pendingCallRow(theme: Theme, label: string): string {
  // `renderStatusLine({icon:"pending", titleColor:"toolTitle"})` with no
  // description/meta, spelled out because the host's `Theme` class type is
  // nominal (`#private`) and cannot be structurally satisfied by our duck-typed
  // subset: same icon source, same color, same one row.
  const icon = theme.styledSymbol?.("status.pending", "muted") ?? "⏳";
  return `${icon} ${theme.fg("toolTitle", label)}`;
}

/**
 * Complete pending row, including the leading column the host does not add for a
 * framed component. Exported because the design preview (`dev/render-preview`,
 * kept on the `dev-preview` branch) renders this exact string instead of
 * re-assembling it: a missing prefix is one column of drift.
 */
export function renderPendingRow(theme: Theme, label: string): string {
  return ` ${pendingCallRow(theme, label)}`;
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
   * flips, so a half-streamed command never draws a frame.
   */
  argsComplete?: boolean;
}

/** Status icon + label for the divider line (exit-code aware). */
function renderStatusLabel(
  d: PwshDetails,
  isError: boolean,
  theme: Theme,
  isPartial = false,
): string {
  if (isPartial || d.streaming) {
    return `${theme.fg("accent", "●")} running · Wall: ${(d.wallTimeMs / 1000).toFixed(2)}s | Timeout: ${d.timeoutSec}s`;
  }
  const hasExitCode = d.exitCode != null && d.exitCode !== 0;
  const bad = isError || hasExitCode;
  const icon = d.dead ? "✕" : d.timedOut ? "⏱" : bad ? "✗" : "✓";
  const state = d.dead
    ? "process died"
    : d.timedOut
      ? "timed out"
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
  const exitText = hasExitCode ? ` · exit ${d.exitCode}` : "";
  return `${theme.fg(color, icon)} ${state}${exitText} · Wall: ${(d.wallTimeMs / 1000).toFixed(2)}s | Timeout: ${d.timeoutSec}s`;
}

/** Command source lines shown before collapsing behind a ctrl+o hint. */
const COMMAND_PREVIEW_LINES = 4;

/** Frame options shared by the call, result and preview card builders. */
export interface PwshFrameOptions {
  /** Title label: the model's intent, or the tool label when it declared none. */
  label?: string;
  /**
   * Working directory the call asked for, exactly as the model passed it. The
   * title shows the host's `formatToolWorkingDirectory` form: nothing when it
   * resolves to the session directory, a relative path inside the project, a
   * shortened absolute path outside — the rule the built-in bash card uses.
   */
  cwd?: string;
  /** `false` leaves the frame open for a merged result to follow. */
  closed?: boolean;
  expanded?: boolean;
}

/**
 * Command block rows: wrapped highlighted command lines. Collapsed shows the
 * first `COMMAND_PREVIEW_LINES` source lines plus a hint for the rest;
 * expanded shows every line - multi-line scripts (here-strings, script
 * blocks) used to stop dead after line four with no indication.
 * Shared by renderCall and renderResult (pending + merged frames).
 * `closed: false` leaves the frame open (no bottom bar) so a merged
 * renderResult can follow with the status divider + output + single bottom.
 */
export function commandBlock(
  theme: Theme,
  width: number,
  command: string,
  options: PwshFrameOptions = {},
): string[] {
  const { cwd, closed = true, expanded = false } = options;
  const title = frameTitle(
    theme,
    options.label ?? TOOL_LABEL,
    formatToolWorkingDirectory(cwd, process.cwd()),
  );
  const out: string[] = [frameTop(width, theme, title)];
  let lines: string[];
  try {
    lines = highlightPowerShell(command, theme);
  } catch {
    lines = command.split("\n");
  }
  // A trailing newline in the submitted command is not a command line.
  while (lines.length > 1 && lines[lines.length - 1]!.trim() === "") lines.pop();
  const visibleCount = expanded
    ? lines.length
    : Math.min(lines.length, COMMAND_PREVIEW_LINES);
  const maxCommandWidth = Math.max(1, frameInnerWidth(width) - 2);
  for (const line of lines.slice(0, visibleCount)) {
    for (const wrapped of wrapAnsiLine(line, maxCommandWidth))
      out.push(frameRow(wrapped, width, theme));
  }
  const hiddenLines = lines.length - visibleCount;
  if (hiddenLines > 0) {
    out.push(
      frameRow(
        theme.fg("dim", `… ${hiddenLines} more lines (ctrl+o to expand)`),
        width,
        theme,
      ),
    );
  }
  if (closed) out.push(frameBottom(width, theme));
  return out;
}

function renderBody(
  d: PwshDetails,
  expanded: boolean,
  theme: Theme,
  width: number,
): string[] {
  // Normalize CRLF: pwsh emits \r\n frames that would make the terminal
  // cursor jump back to line start (blank-looking rows).
  const body = (d.error ?? d.output ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  if (!body) return [];
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
  const maxBodyWidth = Math.max(1, frameInnerWidth(width) - 2);
  for (const line of trimmed) {
    const blank = line.trim() === "";
    if (blank && prevBlank) continue;
    prevBlank = blank;
    bodyLines.push(...wrapAnsiLine(line, maxBodyWidth));
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
  return lines;
}

/**
 * Merged result frame: command block (left open) + status divider + output
 * rows + a single bottom bar. Called by `renderResult` in `pwsh-tool.ts`, and by
 * the design preview (`dev/render-preview`, kept on the `dev-preview` branch),
 * which renders this builder instead of a copy so the mock cannot drift.
 */
export function renderCard(
  theme: Theme,
  width: number,
  command: string,
  details: PwshDetails,
  options: PwshRenderOptions & PwshFrameOptions & { isError?: boolean } = {},
): string[] {
  const expanded = options.expanded === true;
  const out = commandBlock(theme, width, command, {
    label: options.label,
    cwd: options.cwd,
    closed: false,
    expanded,
  });
  out.push(
    frameDivider(
      width,
      theme,
      renderStatusLabel(
        details,
        options.isError === true,
        theme,
        options.isPartial === true,
      ),
    ),
  );
  for (const line of renderBody(details, expanded, theme, width)) {
    out.push(frameRow(line, width, theme));
  }
  if (expanded && details.dead) {
    out.push(
      frameRow(
        theme.fg("dim", "session reset; will be rebuilt on next call"),
        width,
        theme,
      ),
    );
  }
  out.push(frameBottom(width, theme));
  return out;
}
