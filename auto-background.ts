/**
 * Auto-background policy for the pwsh tool.
 *
 * A foreground `pwsh` call that outstays its wait budget becomes a background
 * job instead of blocking the turn — the command keeps running on its session
 * and its result is delivered later, like the host's own `bash` tool. The
 * budget and the settlement race here mirror the host's shared helpers
 * (`packages/coding-agent/src/async/auto-background.ts`) so a pwsh call
 * backgrounds exactly when a bash call would.
 */

/** Default foreground-wait threshold before a call auto-backgrounds (bash's default). */
export const DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS = 60_000;

/**
 * Whether auto-backgrounding is on until a settings layer says otherwise. Bash
 * ships it enabled; pwsh mirrors that so both shells behave the same.
 */
export const DEFAULT_AUTO_BACKGROUND_ENABLED = true;

/**
 * Subtracted from a call's own deadline when it is shorter than the threshold:
 * a command about to be killed by its timeout must resolve inline, not
 * background one second before the deadline fires.
 */
export const AUTO_BACKGROUND_TIMEOUT_BUFFER_MS = 1_000;

/**
 * Abort reason the agent loop carries on an *interruptible* tool's signal when
 * queued steering, a peer IRC message, or a background completion cuts the call
 * short (`packages/agent/src/agent-loop.ts`). Compared through the global symbol
 * registry, so distinguishing "step aside" from a real cancellation needs no
 * runtime import of the host's agent package.
 */
export const TOOL_INTERRUPT_ABORT_REASON = Symbol.for(
  "pi-agent-core.tool-interrupt",
);

/**
 * How long a foreground call waits before backgrounding. `0` (or a non-positive
 * threshold) means background immediately; a call deadline shortens the wait to
 * one buffer before it.
 */
export function resolveAutoBackgroundWaitMs(
  thresholdMs: number,
  timeoutMs: number | undefined,
): number {
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) return 0;
  if (timeoutMs === undefined) return thresholdMs;
  return Math.max(
    0,
    Math.min(thresholdMs, timeoutMs - AUTO_BACKGROUND_TIMEOUT_BUFFER_MS),
  );
}

/** Why a foreground wait ended, when it did not end with the command's result. */
export type ForegroundWaitOutcome = "threshold" | "steer" | "aborted";

export type ForegroundWaitResult<T> =
  | { outcome: "completed"; value: T }
  | { outcome: ForegroundWaitOutcome };

/**
 * Race a running command against the wait budget, the caller's abort signal, and
 * the turn's steering signal (which reaches an interruptible tool through that
 * same signal, see {@link TOOL_INTERRUPT_ABORT_REASON}).
 *
 * Returns the command's own result when it settles first; otherwise why the wait
 * ended: `threshold` (budget elapsed — background it), `steer` (a queued message
 * or peer interrupted the call — background it, the command keeps running), or
 * `aborted` (the caller cancelled — kill it).
 *
 * The threshold timer is always cleared, so a wait that ends early leaves no
 * live timer behind to delay shutdown.
 */
export async function raceForegroundWait<T>(
  run: Promise<T>,
  waitMs: number,
  signal?: AbortSignal,
): Promise<ForegroundWaitResult<T>> {
  if (waitMs <= 0) return { outcome: "threshold" };
  if (signal?.aborted) {
    return {
      outcome:
        signal.reason === TOOL_INTERRUPT_ABORT_REASON ? "steer" : "aborted",
    };
  }

  const { promise: threshold, resolve: resolveThreshold } =
    Promise.withResolvers<ForegroundWaitResult<T>>();
  const timer = setTimeout(
    () => resolveThreshold({ outcome: "threshold" }),
    waitMs,
  );

  const { promise: interrupted, resolve: resolveInterrupted } =
    Promise.withResolvers<ForegroundWaitResult<T>>();
  const waiters: Array<Promise<ForegroundWaitResult<T>>> = [
    run.then((value) => ({ outcome: "completed" as const, value })),
    threshold,
  ];
  let onAbort: (() => void) | undefined;
  if (signal) {
    onAbort = () =>
      resolveInterrupted({
        outcome:
          signal.reason === TOOL_INTERRUPT_ABORT_REASON ? "steer" : "aborted",
      });
    signal.addEventListener("abort", onAbort, { once: true });
    waiters.push(interrupted);
  }
  try {
    return await Promise.race(waiters);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
