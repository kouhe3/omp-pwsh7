/**
 * Terminal-text sanitization shared by the card (`card.ts`) and the job listing
 * (`job.ts`): the one place untrusted text (the model's intent / jobId / cwd,
 * command output, script errors) is stripped of control sequences before it can
 * reach a terminal.
 *
 * It lives in its own dependency-free module so `job.ts` can sanitize without
 * importing `card.ts` (which pulls in Shiki and pi-tui through `syntax.ts`) — the
 * core job logic must not drag the renderer's graph into its own.
 */

/**
 * C0/C1 controls (ESC included) minus tab and newline. Mirrors the host's
 * `sanitizeText` (`@oh-my-pi/pi-utils`): tab and newline are structure the
 * renderers re-wrap themselves, everything else a terminal would interpret is
 * dropped.
 */
const TERMINAL_CONTROL_RE = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;

/**
 * Strip terminal control sequences from untrusted text.
 *
 * The host paints a rows renderer's output verbatim (`paintRows` in its own
 * tool look, `ui/styles/tools/legacy.ts`), so an OSC 52 clipboard sequence in a
 * job's output would otherwise be written straight to the user's terminal.
 *
 * Call it on *raw* text only: the theme colors and Shiki highlights composed
 * afterwards are ours and must survive (sanitizing a composed row would strip
 * the card's own styling).
 */
export function sanitizeTerminalText(text: string): string {
  TERMINAL_CONTROL_RE.lastIndex = 0;
  if (TERMINAL_CONTROL_RE.exec(text) === null) return text;
  TERMINAL_CONTROL_RE.lastIndex = 0;
  return Bun.stripANSI(text).replace(TERMINAL_CONTROL_RE, "");
}
