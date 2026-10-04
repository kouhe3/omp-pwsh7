import { expect, test } from "bun:test";
import {
  HostPwshJobs,
  hostAsyncJobs,
  type HostAsyncJobRunContext,
  type HostAsyncJobs,
} from "./host-jobs";
import { getJobManager, resetJobManager } from "./pwsh-tool";
import { MAX_RETAINED_SETTLED_JOBS } from "./job";
import type { PwshRunOptions, PwshRunResult, PwshSessionPool } from "./session";

interface RegisteredJob {
  kind: string;
  label: string;
  run: (ctx: HostAsyncJobRunContext) => Promise<string>;
  process?: { command: string; cwd: string; pids: () => readonly number[] };
}

/**
 * Host stub for the scoped async-job surface: records registrations, keeps the
 * per-job abort controller the real manager owns, and lets the test drive the
 * body and the cancellation exactly as the manager would.
 */
function fakeHost() {
  const jobs: RegisteredJob[] = [];
  const cancelled: string[] = [];
  const controllers = new Map<string, AbortController>();
  const surface: HostAsyncJobs = {
    register(kind, label, run, options) {
      const id = `host-${jobs.length + 1}`;
      controllers.set(id, new AbortController());
      jobs.push({ kind, label, run, process: options?.process });
      return id;
    },
    cancel(jobId) {
      const controller = controllers.get(jobId);
      if (!controller || controller.signal.aborted) return false;
      cancelled.push(jobId);
      controller.abort();
      return true;
    },
  };
  return { surface, jobs, cancelled, controllers };
}

/** Pool stub: one session per key, answering with a canned run result. */
function fakePool(result: PwshRunResult, onRun?: (options: PwshRunOptions) => void) {
  const disposed: string[] = [];
  const pid = 4242;
  const pool = {
    getOrCreate() {
      return {
        run: async (_request: unknown, options: PwshRunOptions) => {
          onRun?.(options);
          return result;
        },
      };
    },
    dispose(key: string) {
      disposed.push(key);
    },
    pidFor() {
      return [pid];
    },
  } as unknown as PwshSessionPool;
  return { pool, disposed, pid };
}

function completed(output: string, exitCode = 0): PwshRunResult {
  return { response: { id: 1, output, exitCode } };
}

/** Awaited rejection as a value: `expect(p).rejects` is typed void in bun:test. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

test("feature detection requires both halves of the host surface", () => {
  const ctx = { asyncJobs: { register: () => "x" } };
  // register-only: no cancel means a kill would surface as a failed job and be
  // delivered as an error, so the surface is rejected.
  expect(hostAsyncJobs(ctx)).toBeUndefined();
  expect(hostAsyncJobs({})).toBeUndefined();
  expect(hostAsyncJobs(undefined)).toBeUndefined();

  const full = fakeHost().surface;
  expect(hostAsyncJobs({ asyncJobs: full })).toBe(full);
});

test("the tool uses the host runtime when the session exposes one", () => {
  const host = fakeHost();
  // Other files in the suite leave a runtime (and its job records) behind.
  resetJobManager();
  try {
    // No surface on the context (stock omp): the private manager keeps jobs.
    const local = getJobManager(undefined, {});
    expect(local.resultDelivery).toBe("self");
    // The same session later hands a context carrying the surface: with no jobs
    // started yet, the runtime upgrades instead of leaving jobs host-invisible.
    const upgraded = getJobManager(undefined, { asyncJobs: host.surface });
    expect(upgraded.resultDelivery).toBe("host");
    expect(upgraded).not.toBe(local);
  } finally {
    resetJobManager();
  }

  try {
    // A register-only surface is refused outright: without cancel, a kill would
    // be reported as a failed job and delivered as an error.
    const registerOnly = getJobManager(undefined, {
      asyncJobs: { register: () => "host-1" },
    });
    expect(registerOnly.resultDelivery).toBe("self");
  } finally {
    resetJobManager();
  }
});

test("startJob registers a pwsh job with the host and reports its result", async () => {
  const host = fakeHost();
  const { pool, pid } = fakePool(completed("hello from pwsh\n"));
  const runtime = new HostPwshJobs(host.surface, pool);

  const job = runtime.startJob({
    command: "Write-Output 'hello'",
    cwd: "C:/work",
    intent: "Printing a greeting",
  });

  const registered = host.jobs[0]!;
  expect(registered.kind).toBe("pwsh");
  expect(registered.label).toBe("Printing a greeting");
  expect(registered.process?.command).toBe("Write-Output 'hello'");
  expect(registered.process?.cwd).toBe("C:/work");
  expect(registered.process?.pids()).toEqual([pid]);
  expect(job.id).toBe("host-1");
  expect(runtime.listJobs().map((entry) => entry.id)).toEqual(["host-1"]);

  const progress: string[] = [];
  const delivery = await registered.run({
    jobId: "host-1",
    signal: new AbortController().signal,
    reportProgress: async (text) => {
      progress.push(text);
    },
  });

  expect(delivery).toContain("PowerShell background job 'host-1' completed");
  expect(delivery).toContain("Exit code: 0");
  expect(delivery).toContain("hello from pwsh");
  expect(job.status).toBe("completed");
  expect(runtime.getJob("host-1")).toBe(job);
  expect((await job.settled).status).toBe("completed");
});

test("streamed output reaches the host as progress and stays on the job record", async () => {
  const host = fakeHost();
  const frames: Array<Record<string, unknown> | undefined> = [];
  const { pool } = fakePool(completed("done"), (options) => options.onChunk?.("partial\n"));
  const runtime = new HostPwshJobs(host.surface, pool);
  const job = runtime.startJob({ command: "Start-Sleep 1", cwd: "C:/work" });

  await host.jobs[0]!.run({
    jobId: job.id,
    signal: new AbortController().signal,
    reportProgress: async (_text, details) => {
      frames.push(details);
    },
  });

  expect(job.output).toContain("partial");
  expect(frames[0]).toEqual({
    output: "partial\n",
    async: { state: "running", jobId: "host-1", type: "pwsh" },
  });
});

test("killJob cancels through the host and settles the body as cancelled", async () => {
  const host = fakeHost();
  let runSignal: AbortSignal | undefined;
  const { pool } = fakePool(completed("never"), (options) => {
    runSignal = options.signal;
  });
  const runtime = new HostPwshJobs(host.surface, pool);
  const job = runtime.startJob({ command: "Start-Sleep 30", cwd: "C:/work" });

  // The run is in flight and waiting for the abort the kill will deliver.
  const running = host.jobs[0]!.run({
    jobId: job.id,
    signal: new AbortController().signal,
    reportProgress: async () => {},
  });

  expect(runtime.killJob(job.id)?.status).toBe("killed");
  expect(host.cancelled).toEqual(["host-1"]);
  // The host's abort reaches the running command, not just the record.
  expect(runSignal?.aborted).toBe(true);
  expect(host.controllers.get("host-1")?.signal.aborted).toBe(true);

  // A cancelled body throws, which is how the manager keeps status `cancelled`
  // and suppresses the completion delivery.
  expect((await rejectionOf(running))?.message).toBe("Cancelled.");
  expect(runtime.getJob(job.id)?.status).toBe("killed");
  expect(runtime.killJob("host-1")).toBeDefined();
  expect(host.cancelled).toEqual(["host-1"]);
});

test("a failed command is delivered as an error, and a refused register leaves no record", async () => {
  const host = fakeHost();
  const { pool } = fakePool({ response: { id: 1, output: "", exitCode: 2, error: "boom" } });
  const runtime = new HostPwshJobs(host.surface, pool);
  const job = runtime.startJob({ command: "exit 2", cwd: "C:/work" });

  const failure = await rejectionOf(
    host.jobs[0]!.run({
      jobId: job.id,
      signal: new AbortController().signal,
      reportProgress: async () => {},
    }),
  );
  expect(failure?.message).toBe("boom");
  expect(runtime.getJob(job.id)?.status).toBe("failed");

  const refusing: HostAsyncJobs = {
    register() {
      throw new Error("Background job limit reached (15).");
    },
    cancel() {
      return false;
    },
  };
  const limited = new HostPwshJobs(refusing, pool);
  expect(() => limited.startJob({ command: "x", cwd: "C:/work" })).toThrow(
    "Background job limit reached",
  );
  expect(limited.listJobs()).toEqual([]);
});

test("waitJob reports a timeout while running and the settled state afterwards", async () => {
  const host = fakeHost();
  const { pool, disposed } = fakePool(completed("late"));
  const runtime = new HostPwshJobs(host.surface, pool);
  const job = runtime.startJob({ command: "Start-Sleep 5", cwd: "C:/work" });

  const timedOut = await runtime.waitJob(job.id, undefined, 10);
  expect(timedOut).toEqual({ job, outcome: "timeout" });
  expect(timedOut?.job.status).toBe("running");
  expect(runtime.killJob("missing")).toBeUndefined();
  expect((await runtime.waitJob("missing", undefined, 0)) ?? null).toBeNull();

  await host.jobs[0]!.run({
    jobId: job.id,
    signal: new AbortController().signal,
    reportProgress: async () => {},
  });
  const settled = await runtime.waitJob(job.id, undefined, 0);
  expect(settled?.outcome).toBe("settled");
  expect(settled?.job.output).toContain("late");
  // The job's pooled session is released on settle, like the private manager.
  expect(disposed).toHaveLength(1);
});

test("retains at most the newest settled records, like the private manager", async () => {
  const host = fakeHost();
  const { pool } = fakePool(completed("ok"));
  const runtime = new HostPwshJobs(host.surface, pool);
  const total = MAX_RETAINED_SETTLED_JOBS + 5;
  const ids: string[] = [];

  for (let index = 0; index < total; index++) {
    const job = runtime.startJob({
      command: `Write-Output 'job-${index}'`,
      cwd: "C:/work",
    });
    ids.push(job.id);
    await host.jobs[index]!.run({
      jobId: job.id,
      signal: new AbortController().signal,
      reportProgress: async () => {},
    });
  }

  // Each record keeps up to 1 MB of output, so an unbounded map is a leak.
  expect(runtime.listJobs().length).toBe(MAX_RETAINED_SETTLED_JOBS);
  expect(runtime.getJob(ids[total - 1]!)).toBeDefined();
  expect(runtime.getJob(ids[0]!)).toBeUndefined();
});

test("progress frames carry a bounded tail plus the output field", async () => {
  const host = fakeHost();
  const big = "x".repeat(120 * 1024);
  const texts: string[] = [];
  const frames: Array<Record<string, unknown> | undefined> = [];
  const { pool } = fakePool(completed("done"), (options) =>
    options.onChunk?.(big),
  );
  const runtime = new HostPwshJobs(host.surface, pool);
  const job = runtime.startJob({ command: "Write-Output big", cwd: "C:/work" });

  await host.jobs[0]!.run({
    jobId: job.id,
    signal: new AbortController().signal,
    reportProgress: async (text, details) => {
      texts.push(text);
      frames.push(details);
    },
  });

  const tail = big.slice(-50 * 1024);
  expect(texts[0]).toBe(tail);
  // `output` keeps bash's `proc://` snapshot parity without the 120 KiB text.
  expect(frames[0]?.output).toBe(tail);
});

test("a session run that throws settles the job as failed", async () => {
  const host = fakeHost();
  const pool = {
    getOrCreate() {
      return {
        run: async () => {
          throw new Error("spawn failed");
        },
      };
    },
    dispose() {},
    pidFor() {
      return [];
    },
  } as unknown as PwshSessionPool;
  const runtime = new HostPwshJobs(host.surface, pool);
  const job = runtime.startJob({ command: "x", cwd: "C:/work" });

  const failure = await rejectionOf(
    host.jobs[0]!.run({
      jobId: job.id,
      signal: new AbortController().signal,
      reportProgress: async () => {},
    }),
  );

  // The shared run helper folds a thrown run into the record, so the job never
  // stays `running` after its body settles.
  expect(failure?.message).toBe("spawn failed");
  expect(job.status).toBe("failed");
  expect(job.error).toBe("spawn failed");
  expect((await job.settled).status).toBe("failed");
});
