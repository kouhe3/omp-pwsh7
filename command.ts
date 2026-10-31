/**
 * `/pwsh` argument parsing and reporting.
 *
 * The command lists background jobs, and doubles as the tool's settings surface:
 * an extension-registered setting cannot appear in the `/settings` panel — that
 * panel builds its rows from the host's own settings modules
 * (`packages/coding-agent/src/config/settings-ui.ts` → `orderedSettings()`, a
 * memoized walk of a hardcoded domain list) — so the switch and the threshold
 * are edited here instead, writing the same global config layer the panel writes.
 */
import type { AutoBackgroundReport } from "./settings";

export type PwshCommand =
  | { kind: "jobs" }
  | { kind: "help" }
  | { kind: "showMode" }
  | { kind: "setMode"; enabled: boolean }
  | { kind: "showThreshold" }
  | { kind: "setThreshold"; thresholdMs: number }
  | { kind: "resetThreshold" }
  | { kind: "unknown"; token: string };

export const PWSH_COMMAND_USAGE = [
  "/pwsh — list background jobs",
  "/pwsh mode — show the execution mode (stateless bash-style vs persistent session)",
  "/pwsh mode on|off — switch it; persisted to the global config",
  "/pwsh threshold — show the auto-background threshold",
  "/pwsh threshold 30s|30000|default — set it, or drop the key so the default applies",
].join("\n");

/** Spellings accepted for the two modes, normalized to the switch value. */
const MODE_VALUES: Record<string, boolean> = {
  on: true,
  stateless: true,
  bash: true,
  true: true,
  "1": true,
  yes: true,
  off: false,
  persistent: false,
  stateful: false,
  session: false,
  false: false,
  "0": false,
  no: false,
};

/** Values that remove a numeric key instead of setting it. */
const RESET_VALUES = new Set(["default", "reset", "unset", "none", "clear"]);

/**
 * Parse the command line. Anything unrecognized comes back as `unknown` so the
 * handler can show the usage instead of guessing at an intent (`/pwsh` with no
 * arguments keeps meaning "list jobs").
 */
export function parsePwshCommand(args: string): PwshCommand {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const head = tokens[0]?.toLowerCase();
  if (!head || head === "jobs" || head === "list") return { kind: "jobs" };
  if (head === "help" || head === "-h" || head === "--help" || head === "?") {
    return { kind: "help" };
  }
  const value = tokens[1]?.toLowerCase();
  if (head === "mode") {
    if (value === undefined) return { kind: "showMode" };
    const enabled = MODE_VALUES[value];
    return enabled === undefined
      ? { kind: "unknown", token: tokens[1] ?? "" }
      : { kind: "setMode", enabled };
  }
  if (head === "threshold") {
    if (value === undefined) return { kind: "showThreshold" };
    if (RESET_VALUES.has(value)) return { kind: "resetThreshold" };
    const thresholdMs = parseDurationMs(value);
    return thresholdMs === undefined
      ? { kind: "unknown", token: tokens[1] ?? "" }
      : { kind: "setThreshold", thresholdMs };
  }
  return { kind: "unknown", token: tokens[0] ?? "" };
}

/** `30`/`30000` = milliseconds, `30s`/`500ms` = suffixed; negative/NaN = invalid. */
function parseDurationMs(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(value);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  const unit = match[2] ?? "ms";
  const scale = unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
  return Math.max(0, Math.floor(amount * scale));
}

/** Whole seconds when the value divides evenly, else milliseconds. */
export function formatDurationMs(ms: number): string {
  if (ms === 0) return "0s (background immediately)";
  return ms % 1_000 === 0 ? `${ms / 1_000}s` : `${ms}ms`;
}

/** How the tool behaves, and where the setting came from. */
export function formatModeReport(report: AutoBackgroundReport): string {
  const source = report.provenance ? `\nsource: ${report.provenance}` : "";
  return `${report.settings.enabled ? STATELESS_MODE_TEXT : PERSISTENT_MODE_TEXT}${source}`;
}

/** Auto-background threshold, in the unit the config key uses. */
export function formatThresholdReport(report: AutoBackgroundReport): string {
  const source = report.provenance ? `\nsource: ${report.provenance}` : "";
  const effect = report.settings.enabled
    ? "A foreground command still running after it moves to a background job."
    : "Auto-backgrounding is off in the current mode (/pwsh mode on enables it).";
  return `pwsh auto-background threshold: ${formatDurationMs(report.settings.thresholdMs)}\n${effect}${source}`;
}

/**
 * Appended when a command just changed the mode: behavior follows the write at
 * once (the tool reads the setting per call), but the description in the
 * model's prompt is baked at extension load.
 */
export const DESCRIPTION_REFRESH_NOTE =
  "The description the model sees still states the previous mode until the session restarts; behavior already follows the new value.";

/** Completions for `/pwsh ` — the surface is discoverable only through the command. */
export function pwshArgumentCompletions(
  prefix: string,
): Array<{ value: string; label: string; description?: string }> {
  const items = [
    { value: "mode", label: "mode", description: "Show the execution mode" },
    {
      value: "mode on",
      label: "mode on",
      description: "Stateless bash-style mode",
    },
    {
      value: "mode off",
      label: "mode off",
      description: "Persistent session mode",
    },
    {
      value: "threshold",
      label: "threshold",
      description: "Show the auto-background threshold",
    },
    {
      value: "threshold 30s",
      label: "threshold 30s",
      description: "Background after 30s",
    },
    {
      value: "threshold default",
      label: "threshold default",
      description: "Drop the key; 60s default",
    },
    { value: "help", label: "help", description: "Usage" },
  ];
  const trimmed = prefix.trimStart();
  if (trimmed.length === 0) return items;
  return items.filter((item) => item.value.startsWith(trimmed));
}

const STATELESS_MODE_TEXT =
  "pwsh mode: stateless (bash-style) — every call runs in its own fresh session, so variables, modules, and location do not persist; a call that outstays the threshold moves to a background job; a process it detaches with Start-Process keeps running.";
const PERSISTENT_MODE_TEXT =
  "pwsh mode: persistent — one session keeps variables, modules, and location across calls; long-running calls are never auto-backgrounded.";

/** Shown when the settings surface is unavailable, instead of a false save. */
export const SETTINGS_UNAVAILABLE_TEXT =
  "Settings are unavailable in this session, so /pwsh cannot change the mode. Set pwsh.autoBackground.enabled / pwsh.autoBackground.thresholdMs in ~/.omp/agent/config.yml (or a project config.yml) instead.";
