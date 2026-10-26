import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS,
  TOOL_INTERRUPT_ABORT_REASON,
  raceForegroundWait,
  resolveAutoBackgroundWaitMs,
} from "./auto-background";
import { PwshJobManager, type PwshJobsRuntime } from "./job";
import { runPwsh, type PwshAutoBackground } from "./pwsh-tool";
import type { PwshRunOptions, PwshRunResult, PwshSessionPool } from "./session";

/** A command that never finishes on its own — only an abort or the test ends it. */
const pending = <T>() => new Promise<T>(() => {});

/** Run result of a command that completed normally. */
const OK: PwshRunResult = {
  response: { id: 1, output: "done", exitCode: 0 },
};

interface FakeApiOptions {
  /** Settles the command; defaults to a command only an abort can end. */
  result?: Promise<PwshRunResult>;
  /** Chunks replayed through `onChunk` as the command starts. */
  initialChunks?: readonly string[];
}

/**
 * A `PwshApi` over one fake session: the command settles exactly when the test
 * says, honors the signal it was handed (so the abort/kill path is observable),
 * and exposes the live `onChunk` sink so a test can stream after adoption.
 *
 * The threshold timers in these tests need no fake clock: a `pending` command
 * never races them, and every other case settles only when the test resolves it.
 */
function fakeApi(options: FakeApiOptions = {}) {
  const seen: { signal?: AbortSignal } = {};
  const keys: string[] = [];
  const disposed: string[] = [];
  let sink: ((text: string) => void) | undefined;
  const session = {
    pid: 4242,
    dead: false,
    run: async (_request: unknown, runOptions: PwshRunOptions) => {
      seen.signal = runOptions.signal;
      sink = runOptions.onChunk;
      for (const chunk of options.initialChunks ?? [])
        runOptions.onChunk?.(chunk);
      const result = options.result ?? pending<PwshRunResult>();
      const aborted = new Promise<PwshRunResult>((resolve) => {
        const kill = () => resolve({ aborted: true, partialOutput: "partial" });
        if (runOptions.signal?.aborted) kill();
        else runOptions.signal?.addEventListener("abort", kill, { once: true });
      });
      return await Promise.race([result, aborted]);
    },
  };
  return {
    seen,
    keys,
    disposed,
    emit: (text: string) => sink?.(text),
    api: {
      getOrCreate: (key: string) => {
        keys.push(key);
        return session;
      },
      restart: async () => session,
      dispose: (key: string) => {
        disposed.push(key);
      },
      pidFor: () => [4242],
    },
  };
}

/** Runtime that only records adoption attempts; used where a job must not appear. */
function refusingRuntime(onAdopt?: () => void): PwshJobsRuntime {
  return {
    adoptJob: () => {
      onAdopt?.();
      return undefined;
    },
  } as unknown as PwshJobsRuntime;
}

test("wait budget mirrors bash: threshold, or one second inside the deadline", () => {
  expect(resolveAutoBackgroundWaitMs(60_000, undefined)).toBe(60_000);
  expect(resolveAutoBackgroundWaitMs(60_000, 120_000)).toBe(60_000);
  expect(resolveAutoBackgroundWaitMs(60_000, 30_000)).toBe(29_000);
  expect(resolveAutoBackgroundWaitMs(60_000, 500)).toBe(0);
  expect(resolveAutoBackgroundWaitMs(0, undefined)).toBe(0);
  expect(resolveAutoBackgroundWaitMs(-5, 120_000)).toBe(0);
  expect(resolveAutoBackgroundWaitMs(Number.NaN, 120_000)).toBe(0);
});

test("the wait ends with the command when the command finishes first", async () => {
  expect(await raceForegroundWait(Promise.resolve("ok"), 5_000)).toEqual({
    outcome: "completed",
    value: "ok",
  });
});

test("an elapsed budget reports a threshold, and a zero budget never waits", async () => {
  expect(await raceForegroundWait(pending<string>(), 5)).toEqual({
    outcome: "threshold",
  });
  expect(await raceForegroundWait(pending<string>(), 0)).toEqual({
    outcome: "threshold",
  });
});

test("steering and cancellation are told apart by the abort reason", async () => {
  const steered = new AbortController();
  const cancelled = new AbortController();
  const steerWait = raceForegroundWait(
    pending<string>(),
    5_000,
    steered.signal,
  );
  const cancelWait = raceForegroundWait(
    pending<string>(),
    5_000,
    cancelled.signal,
  );
  steered.abort(TOOL_INTERRUPT_ABORT_REASON);
  cancelled.abort(new Error("stopped"));
  expect(await steerWait).toEqual({ outcome: "steer" });
  expect(await cancelWait).toEqual({ outcome: "aborted" });
});

test("an already-aborted signal short-circuits the wait", async () => {
  const controller = new AbortController();
  controller.abort(TOOL_INTERRUPT_ABORT_REASON);
  expect(
    await raceForegroundWait(pending<string>(), 5_000, controller.signal),
  ).toEqual({ outcome: "steer" });
});

test("threshold elapse backgrounds the command and folds its result later", async () => {
  const settled = Promise.withResolvers<PwshRunResult>();
  const { api, seen, emit, keys, disposed } = fakeApi({
    result: settled.promise,
    initialChunks: ["pre\n"],
  });
  const delivered: Array<{ customType?: string }> = [];
  const jobs = new PwshJobManager(
    {} as PwshSessionPool,
    {
      sendMessage: (message: { customType?: string }) => {
        delivered.push(message);
      },
    } as unknown as ExtensionAPI,
  );
  const policy: PwshAutoBackground = {
    enabled: true,
    thresholdMs: 10,
    runtime: jobs,
    resolveIntent: () => "Run long build",
  };

  const result = await runPwsh(
    { command: "Start-Sleep 30" },
    api,
    undefined,
    undefined,
    policy,
  );

  expect(result.text).toContain("Backgrounded as job");
  // The bash-aligned mode: the command owns its process, so nothing is held.
  expect(result.text).toContain("its own PowerShell process");
  expect(keys[0]?.startsWith("auto:")).toBe(true);
  expect(result.details.async).toBe(true);
  expect(result.details.status).toBe("running");
  const job = jobs.getJob(result.details.jobId ?? "");
  expect(job?.status).toBe("running");
  // `i` was stripped from the parameters, so the label comes from the resolver.
  expect(job?.resolveIntent?.()).toBe("Run long build");
  // Output produced before adoption seeds the record; later output appends.
  expect(job?.output).toBe("pre\n");
  emit("post\n");
  expect(job?.output).toBe("pre\npost\n");
  // The command was never aborted — only the tool call ended.
  expect(seen.signal?.aborted).toBe(false);

  settled.resolve({ response: { id: 1, output: "pre\npost\n", exitCode: 0 } });
  await job?.settled;
  expect(job?.status).toBe("completed");
  // The command's process is retired once it finishes — the stateless mode's
  // counterpart to the process bash drops when its command ends.
  expect(disposed).toEqual([keys[0]]);
  // A settled adopted job delivers its own aside, like a started job.
  await Promise.resolve();
  expect(delivered.map((message) => message.customType)).toEqual([
    "async-result",
  ]);
});

test("steering backgrounds early and keeps the command running", async () => {
  const settled = Promise.withResolvers<PwshRunResult>();
  const { api } = fakeApi({ result: settled.promise });
  const jobs = new PwshJobManager({} as PwshSessionPool);
  const controller = new AbortController();
  const run = runPwsh(
    { command: "Start-Sleep 30" },
    api,
    undefined,
    controller.signal,
    { enabled: true, thresholdMs: 60_000, runtime: jobs },
  );
  controller.abort(TOOL_INTERRUPT_ABORT_REASON);
  const result = await run;

  expect(result.text).toContain(
    "Backgrounded early to handle an incoming message",
  );
  expect(result.details.status).toBe("running");
  const job = jobs.getJob(result.details.jobId ?? "");
  expect(job?.status).toBe("running");

  settled.resolve(OK);
  await job?.settled;
  expect(job?.status).toBe("completed");
});

test("a cancellation kills the command instead of backgrounding it", async () => {
  const { api, seen } = fakeApi();
  const jobs = new PwshJobManager({} as PwshSessionPool);
  const controller = new AbortController();
  const run = runPwsh(
    { command: "Start-Sleep 30" },
    api,
    undefined,
    controller.signal,
    { enabled: true, thresholdMs: 60_000, runtime: jobs },
  );
  controller.abort(new Error("stopped"));
  const result = await run;

  expect(result.text).toContain("Command cancelled");
  expect(seen.signal?.aborted).toBe(true);
  expect(jobs.listJobs()).toHaveLength(0);
});

test("no adoption slot falls back to waiting the command out", async () => {
  const settled = Promise.withResolvers<PwshRunResult>();
  const { api } = fakeApi({ result: settled.promise });
  const adopted = Promise.withResolvers<void>();
  const run = runPwsh(
    { command: "Write-Output 'done'" },
    api,
    undefined,
    undefined,
    {
      enabled: true,
      thresholdMs: 10,
      runtime: refusingRuntime(() => adopted.resolve()),
    },
  );
  await adopted.promise;
  settled.resolve(OK);
  const result = await run;

  expect(result.text).toContain("done");
  expect(result.details.async).toBeUndefined();
  expect(result.details.exitCode).toBe(0);
});

test("a zero threshold backgrounds without waiting at all", async () => {
  const { api } = fakeApi();
  const jobs = new PwshJobManager({} as PwshSessionPool);
  const result = await runPwsh(
    { command: "Start-Sleep 30" },
    api,
    undefined,
    undefined,
    { enabled: true, thresholdMs: 0, runtime: jobs },
  );

  expect(result.text).toContain("Backgrounded as job");
  const job = jobs.listJobs()[0];
  expect(job?.status).toBe("running");
  job?.abortController.abort();
  await job?.settled;
});

test("a call deadline bounds the wait instead of the threshold", async () => {
  const settled = Promise.withResolvers<PwshRunResult>();
  const { api, seen } = fakeApi({ result: settled.promise });
  const jobs = new PwshJobManager({} as PwshSessionPool);
  const run = runPwsh(
    { command: "Write-Output 'done'", timeout: 5 },
    api,
    undefined,
    undefined,
    {
      enabled: true,
      thresholdMs: DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS,
      runtime: jobs,
    },
  );
  // The deadline is 5s and the threshold 60s, so the budget is 4s of waiting —
  // far longer than the command needs once the test settles it.
  settled.resolve(OK);
  const result = await run;

  expect(result.text).toContain("done");
  expect(seen.signal?.aborted).toBe(false);
  expect(jobs.listJobs()).toHaveLength(0);
});

test("auto-backgrounding off keeps the plain foreground contract", async () => {
  const settled = Promise.withResolvers<PwshRunResult>();
  const { api } = fakeApi({ result: settled.promise });
  const jobs = new PwshJobManager({} as PwshSessionPool);
  const run = runPwsh(
    { command: "Write-Output 'done'" },
    api,
    undefined,
    undefined,
    { enabled: false, thresholdMs: 10, runtime: jobs },
  );
  settled.resolve(OK);
  const result = await run;

  expect(result.text).toContain("done");
  expect(result.details.async).toBeUndefined();
  expect(jobs.listJobs()).toHaveLength(0);
});

test("each call in auto-background mode gets its own session, dropped at the end", async () => {
  const first = fakeApi({ result: Promise.resolve(OK) });
  const second = fakeApi({ result: Promise.resolve(OK) });
  const jobs = new PwshJobManager({} as PwshSessionPool);
  const policy: PwshAutoBackground = {
    enabled: true,
    thresholdMs: DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS,
    runtime: jobs,
  };

  await runPwsh(
    { command: "$marker = 'first'" },
    first.api,
    undefined,
    undefined,
    policy,
  );
  await runPwsh(
    { command: "$marker" },
    second.api,
    undefined,
    undefined,
    policy,
  );

  // Distinct keys, so the second call cannot see the first call's variables —
  // and neither session outlives its own command.
  const firstKey = first.keys[0];
  const secondKey = second.keys[0];
  expect(firstKey).toMatch(/^auto:\d+$/);
  expect(secondKey).toMatch(/^auto:\d+$/);
  expect(firstKey).not.toBe(secondKey);
  expect(first.disposed).toEqual([firstKey]);
  expect(second.disposed).toEqual([secondKey]);
  expect(jobs.listJobs()).toHaveLength(0);
});

test("auto-background mode isolates calls even without a job runtime", async () => {
  const { api, keys, disposed } = fakeApi({ result: Promise.resolve(OK) });

  const result = await runPwsh(
    { command: "Write-Output 'done'" },
    api,
    undefined,
    undefined,
    { enabled: true, thresholdMs: DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS },
  );

  expect(result.text).toContain("done");
  expect(result.details.async).toBeUndefined();
  expect(keys[0]).toMatch(/^auto:\d+$/);
  expect(disposed).toEqual([keys[0]]);
});

test("the session name is ignored in auto-background mode", async () => {
  const { api, keys } = fakeApi({ result: Promise.resolve(OK) });

  await runPwsh(
    // A name that could not form a pool key: unused in this mode, so harmless.
    { command: "Write-Output 'done'", session: "we\nird" },
    api,
    undefined,
    undefined,
    { enabled: true, thresholdMs: DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS },
  );

  expect(keys[0]).toMatch(/^auto:\d+$/);
});

test("a restart in auto-background mode says there is nothing to rebuild", async () => {
  const { api, keys } = fakeApi();
  const jobs = new PwshJobManager({} as PwshSessionPool);

  const only = await runPwsh({ restart: true }, api, undefined, undefined, {
    enabled: true,
    thresholdMs: DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS,
    runtime: jobs,
  });

  expect(only.text).toContain("Nothing to restart");
  expect(only.isError).toBeUndefined();
  // Nothing was spawned for a restart that has no session to rebuild.
  expect(keys).toHaveLength(0);
});

test("a restart alongside a command reports the fresh session", async () => {
  const { api } = fakeApi({ result: Promise.resolve(OK) });

  const result = await runPwsh(
    { command: "Write-Output 'done'", restart: true },
    api,
    undefined,
    undefined,
    { enabled: true, thresholdMs: DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS },
  );

  expect(result.text).toContain("Fresh session (pid 4242)");
  expect(result.text).toContain("there was nothing to restart");
});
