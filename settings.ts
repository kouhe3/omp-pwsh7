/**
 * Auto-background settings, declared in omp's own settings registry so the
 * switch is configured exactly like the built-in `bash.autoBackground.*` pair:
 * `~/.omp/agent/config.yml` / `<cwd>/.omp/config.yml`, the settings panel, and
 * `cfg://pwsh.autoBackground.enabled`.
 *
 * The switch selects the tool's execution mode. On: like the built-in bash
 * tool, every call gets its own fresh session and long-running commands move to
 * a background job — the mode in which auto-backgrounding is sound, because
 * nothing a later call needs is held by the running command. Off: the original
 * persistent session that keeps variables, modules, and location across calls.
 *
 * Extensions may read and override registered settings (`docs/extensions.md`);
 * `register` is the same call the host's own domain settings modules use, so the
 * definition lands in the shared registry the panels and `cfg://` enumerate. The
 * handles are read against the host's settings instance (`pi.pi.settings`), which
 * carries the effective merge of every layer, so a read per call sees live
 * edits. Registration is guarded: a host without the registry subpath, or a
 * second load in one process, falls back to the documented defaults instead of
 * failing the whole extension.
 */
import { lookup, register } from "@oh-my-pi/pi-coding-agent/config/registry";
import type { AnySetting } from "@oh-my-pi/pi-coding-agent/config/registry";
import type { Settings } from "@oh-my-pi/pi-coding-agent";
import {
  DEFAULT_AUTO_BACKGROUND_ENABLED,
  DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS,
} from "./auto-background";

export const AUTO_BACKGROUND_ENABLED_ID = "pwsh.autoBackground.enabled";
export const AUTO_BACKGROUND_THRESHOLD_ID = "pwsh.autoBackground.thresholdMs";

/** The registry handles the tool needs, resolved once at load. */
interface AutoBackgroundSettingHandles {
  enabled?: AnySetting;
  thresholdMs?: AnySetting;
}

const handles = resolveHandles();

function resolveHandles(): AutoBackgroundSettingHandles {
  try {
    // `lookup` first: a reload of the same extension module in one process must
    // reuse the registered handle — `register` throws on a duplicate id.
    return {
      enabled:
        lookup(AUTO_BACKGROUND_ENABLED_ID) ??
        register({
          id: AUTO_BACKGROUND_ENABLED_ID,
          type: "boolean",
          default: DEFAULT_AUTO_BACKGROUND_ENABLED,
          ui: {
            tab: "shell",
            label: "pwsh Bash-Style Mode",
            description:
              "Run every pwsh call in its own fresh session, like the bash tool (no state between calls), and move long-running commands to a background job that delivers its result later. Off: one persistent session keeps variables, modules, and location across calls",
          },
        }),
      thresholdMs:
        lookup(AUTO_BACKGROUND_THRESHOLD_ID) ??
        register({
          id: AUTO_BACKGROUND_THRESHOLD_ID,
          type: "number",
          default: DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS,
        }),
    };
  } catch {
    return {};
  }
}

export interface PwshAutoBackgroundSettings {
  enabled: boolean;
  /** Foreground wait before a call backgrounds; `0` backgrounds immediately. */
  thresholdMs: number;
}

/** Effective settings plus the layer that supplied the switch, for reports. */
export interface AutoBackgroundReport {
  settings: PwshAutoBackgroundSettings;
  provenance?: string;
}

/**
 * Effective auto-background settings for `scope` (the host's settings instance).
 * An unreadable scope — a bare test stub, or a registry that refused the
 * definition — reports the documented defaults.
 */
export function readAutoBackgroundSettings(
  scope: Settings | undefined,
): PwshAutoBackgroundSettings {
  // Without a scope (a schema-only test stub, or a host that never initialized
  // its settings) the handles cannot be read at all — report the defaults.
  if (!scope) {
    return {
      enabled: DEFAULT_AUTO_BACKGROUND_ENABLED,
      thresholdMs: DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS,
    };
  }
  const enabled = handles.enabled?.get(scope);
  const threshold = handles.thresholdMs?.get(scope);
  return {
    // An unregistered handle (no registry surface) keeps the documented
    // default; a registered one reports whatever the layers resolved.
    enabled:
      enabled === undefined
        ? DEFAULT_AUTO_BACKGROUND_ENABLED
        : enabled === true,
    thresholdMs:
      typeof threshold === "number" && Number.isFinite(threshold)
        ? Math.max(0, Math.floor(threshold))
        : DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS,
  };
}

/** Effective settings plus where the switch came from, for the `/pwsh` report. */
export function describeAutoBackground(
  scope: Settings | undefined,
): AutoBackgroundReport {
  const report: AutoBackgroundReport = {
    settings: readAutoBackgroundSettings(scope),
  };
  if (scope && handles.enabled) {
    report.provenance = handles.enabled.provenance(scope);
  }
  return report;
}

/**
 * Persist the mode switch into the **global** config layer, exactly as the
 * settings panel and `omp config set` do. Returns false when the registry
 * surface is missing (a host without the registry subpath), so the caller
 * reports that instead of claiming a save that did not happen.
 */
export function setAutoBackgroundEnabled(
  scope: Settings | undefined,
  enabled: boolean,
): boolean {
  if (!scope || !handles.enabled) return false;
  handles.enabled.set(scope, enabled);
  return true;
}

/**
 * Persist the auto-background threshold. `undefined` removes the key, so the
 * declared default applies again (what `omp config reset` would do).
 */
export function setAutoBackgroundThresholdMs(
  scope: Settings | undefined,
  thresholdMs: number | undefined,
): boolean {
  if (!scope || !handles.thresholdMs) return false;
  if (thresholdMs === undefined) handles.thresholdMs.unset(scope);
  else handles.thresholdMs.set(scope, thresholdMs);
  return true;
}

/**
 * The host's settings instance behind an extension API handle — the scope every
 * registry read needs, since it carries the merged config layers.
 *
 * Narrowed at runtime rather than asserted: the tool is also built from
 * schema-only stubs (tests) whose `pi.pi` member does not exist, and a settings
 * read must degrade to the documented defaults instead of throwing at load.
 */
export function settingsScopeOf(pi: unknown): Settings | undefined {
  const sdk: unknown =
    pi && typeof pi === "object" && "pi" in pi ? pi.pi : undefined;
  if (!sdk || typeof sdk !== "object" || !("settings" in sdk)) return undefined;
  const settings = sdk.settings;
  if (!settings || typeof settings !== "object") return undefined;
  // The host's own Settings instance, the one thing every registry handle can
  // be read and written against. Validated only by shape: the host injected it
  // (it is `pi.pi.settings`), and a wrong value fails loudly in the handle.
  return settings as Settings;
}
