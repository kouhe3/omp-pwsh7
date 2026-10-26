import { expect, test } from "bun:test";
// Subpath, not the package root: the root pulls in the whole host graph (35s+
// to import), while the registry and settings modules are what these tests need.
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
  DESCRIPTION_REFRESH_NOTE,
  PWSH_COMMAND_USAGE,
  formatDurationMs,
  formatModeReport,
  formatThresholdReport,
  parsePwshCommand,
  pwshArgumentCompletions,
} from "./command";
import {
  AUTO_BACKGROUND_ENABLED_ID,
  AUTO_BACKGROUND_THRESHOLD_ID,
  describeAutoBackground,
  readAutoBackgroundSettings,
  setAutoBackgroundEnabled,
  setAutoBackgroundThresholdMs,
} from "./settings";

test("no arguments still means the jobs listing", () => {
  expect(parsePwshCommand("")).toEqual({ kind: "jobs" });
  expect(parsePwshCommand("   ")).toEqual({ kind: "jobs" });
  expect(parsePwshCommand("jobs")).toEqual({ kind: "jobs" });
  expect(parsePwshCommand("LIST")).toEqual({ kind: "jobs" });
});

test("the mode switch accepts its aliases", () => {
  expect(parsePwshCommand("mode")).toEqual({ kind: "showMode" });
  for (const on of ["on", "stateless", "bash", "true", "1", "yes", "ON"]) {
    expect(parsePwshCommand(`mode ${on}`)).toEqual({
      kind: "setMode",
      enabled: true,
    });
  }
  for (const off of ["off", "persistent", "session", "false", "0", "no"]) {
    expect(parsePwshCommand(`mode ${off}`)).toEqual({
      kind: "setMode",
      enabled: false,
    });
  }
});

test("the threshold accepts bare milliseconds, suffixes, and resets", () => {
  expect(parsePwshCommand("threshold")).toEqual({ kind: "showThreshold" });
  expect(parsePwshCommand("threshold 30000")).toEqual({
    kind: "setThreshold",
    thresholdMs: 30_000,
  });
  expect(parsePwshCommand("threshold 30s")).toEqual({
    kind: "setThreshold",
    thresholdMs: 30_000,
  });
  expect(parsePwshCommand("threshold 500ms")).toEqual({
    kind: "setThreshold",
    thresholdMs: 500,
  });
  expect(parsePwshCommand("threshold 2m")).toEqual({
    kind: "setThreshold",
    thresholdMs: 120_000,
  });
  // 0 is the documented "background immediately", not a reset.
  expect(parsePwshCommand("threshold 0")).toEqual({
    kind: "setThreshold",
    thresholdMs: 0,
  });
  for (const reset of ["default", "reset", "unset"]) {
    expect(parsePwshCommand(`threshold ${reset}`)).toEqual({
      kind: "resetThreshold",
    });
  }
});

test("unrecognized input is reported instead of guessed at", () => {
  expect(parsePwshCommand("wat")).toEqual({ kind: "unknown", token: "wat" });
  expect(parsePwshCommand("mode maybe")).toEqual({
    kind: "unknown",
    token: "maybe",
  });
  expect(parsePwshCommand("threshold soon")).toEqual({
    kind: "unknown",
    token: "soon",
  });
  expect(parsePwshCommand("threshold -5")).toEqual({
    kind: "unknown",
    token: "-5",
  });
});

test("help is reachable through the usual spellings", () => {
  for (const help of ["help", "?", "-h", "--help"]) {
    expect(parsePwshCommand(help)).toEqual({ kind: "help" });
  }
  expect(PWSH_COMMAND_USAGE).toContain("/pwsh mode on|off");
});

test("durations render in the unit a reader expects", () => {
  expect(formatDurationMs(0)).toBe("0s (background immediately)");
  expect(formatDurationMs(60_000)).toBe("60s");
  expect(formatDurationMs(1_500)).toBe("1500ms");
});

test("reports name the mode, the threshold, and the layer", () => {
  const stateless = formatModeReport({
    settings: { enabled: true, thresholdMs: 60_000 },
    provenance: "default",
  });
  expect(stateless).toContain("stateless (bash-style)");
  expect(stateless).toContain("fresh session");
  expect(stateless).toContain("source: default");

  const persistent = formatModeReport({
    settings: { enabled: false, thresholdMs: 60_000 },
    provenance: "project",
  });
  expect(persistent).toContain("persistent");
  expect(persistent).toContain("source: project");

  const threshold = formatThresholdReport({
    settings: { enabled: true, thresholdMs: 30_000 },
  });
  expect(threshold).toContain("30s");

  // A threshold nobody can reach is worth saying out loud.
  const dormant = formatThresholdReport({
    settings: { enabled: false, thresholdMs: 30_000 },
    provenance: "global",
  });
  expect(dormant).toContain("off in the current mode");
  expect(dormant).toContain("source: global");
  expect(DESCRIPTION_REFRESH_NOTE).toContain("until the session restarts");
});

test("completions cover the whole surface", () => {
  const values = pwshArgumentCompletions("").map((item) => item.value);
  expect(values).toContain("mode");
  expect(values).toContain("mode off");
  expect(values).toContain("threshold 30s");
  expect(pwshArgumentCompletions("mode ").map((item) => item.value)).toEqual([
    "mode on",
    "mode off",
  ]);
  expect(pwshArgumentCompletions("nope")).toEqual([]);
});

test("a missing scope reports the documented defaults", () => {
  expect(readAutoBackgroundSettings(undefined)).toEqual({
    enabled: true,
    thresholdMs: 60_000,
  });
  expect(describeAutoBackground(undefined).provenance).toBeUndefined();
});

test("the writers persist to the global layer and read back through it", () => {
  // An isolated store: writes land in its global layer with no file behind it.
  const scope = Settings.isolated();
  expect(readAutoBackgroundSettings(scope)).toEqual({
    enabled: true,
    thresholdMs: 60_000,
  });

  expect(setAutoBackgroundEnabled(scope, false)).toBe(true);
  expect(readAutoBackgroundSettings(scope)).toEqual({
    enabled: false,
    thresholdMs: 60_000,
  });
  expect(describeAutoBackground(scope).provenance).toBe("global");
  expect(
    scope.getGlobalSettings()[AUTO_BACKGROUND_ENABLED_ID.split(".")[0]],
  ).toEqual({
    autoBackground: { enabled: false },
  });

  expect(setAutoBackgroundThresholdMs(scope, 30_000)).toBe(true);
  expect(readAutoBackgroundSettings(scope).thresholdMs).toBe(30_000);

  // `undefined` drops the key again, so the declared default applies.
  expect(setAutoBackgroundThresholdMs(scope, undefined)).toBe(true);
  expect(readAutoBackgroundSettings(scope).thresholdMs).toBe(60_000);
  expect(
    scope.getGlobalSettings()[AUTO_BACKGROUND_THRESHOLD_ID.split(".")[0]],
  ).toEqual({ autoBackground: { enabled: false } });
});
