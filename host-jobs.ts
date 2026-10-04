/**
 * Host-backed pwsh background jobs.
 *
 * omp's session exposes a scoped async-job surface (`ctx.asyncJobs`) that lets an
 * extension register jobs which ride the same lifecycle as the built-in
 * `bash`/`task`/`eval` jobs: a row in the jobs sheet with progress and the live
 * pid, the session's running-job cap, cancellation from either side, and
 * completion delivery that wakes the model. Stock omp (18.4/18.6) has no such
 * surface, so the tool falls back to its own {@link PwshJobManager}; this runtime
 * is only selected when the surface is present and complete.
 *
 * Delivery ownership moves to the host: the job body returns the result text and
 * the manager posts the `async-result` aside. A `wait` therefore reports the
 * settled state and leaves the payload to that delivery instead of inlining an
 * output the model is about to receive anyway (`resultDelivery: "host"`).
 *
 * The surface is typed structurally, not imported from the SDK: the extension
 * compiles against a published omp whose `ExtensionContext` has no `asyncJobs`
 * field, and must keep compiling — and runtime-degrading — when it is loaded
 * into that host.
 */
import {
  DEFAULT_TIMEOUT_SEC,
  jobLabel,
  jobResultText,
  pruneSettledJobs,
  runPwshJob,
  type PwshJob,
  type PwshJobsRuntime,
  type PwshWaitOutcome,
  type StartJobOptions,
} from "./job";
import type { PwshSessionPool } from "./session";

/** Running-progress text cap, matching bash's 50 KiB streaming preview. */
const PROGRESS_TAIL_CHARS = 50 * 1024;

/** What a registered job body receives from the host manager. */
export interface HostAsyncJobRunContext {
  jobId: string;
  signal: AbortSignal;
  reportProgress: (
    text: string,
    details?: Record<string, unknown>,
  ) => Promise<void>;
}

/** The process a job runs, for the jobs sheet. */
export interface HostAsyncJobProcess {
  command: string;
  cwd: string;
  pids: () => readonly number[];
}

export interface HostAsyncJobOptions {
  process?: HostAsyncJobProcess;
  onProgress?: (
    text: string,
    details?: Record<string, unknown>,
  ) => void | Promise<void>;
}

/**
 * Structural view of omp's scoped async-job surface. `cancel` is required: a
 * job whose only kill path were the extension's own abort would surface as a
 * *failed* job and would have its error delivered, so a host without it gets the
 * private manager instead of a half-working mode.
 */
export interface HostAsyncJobs {
  register(
    kind: string,
    label: string,
    run: (ctx: HostAsyncJobRunContext) => Promise<string>,
    options?: HostAsyncJobOptions,
  ): string;
  cancel(jobId: string): boolean;
}

/** Feature-detect the surface on a tool/command context. */
export function hostAsyncJobs(ctx: unknown): HostAsyncJobs | undefined {
  const candidate = (
    ctx as { asyncJobs?: Partial<HostAsyncJobs> } | null | undefined
  )?.asyncJobs;
  if (!candidate) return undefined;
  if (
    typeof candidate.register !== "function" ||
    typeof candidate.cancel !== "function"
  ) {
    return undefined;
  }
  return candidate as HostAsyncJobs;
}

export class HostPwshJobs implements PwshJobsRuntime {
  readonly resultDelivery = "host" as const;
  readonly #jobs = new Map<string, PwshJob>();
  readonly #asyncJobs: HostAsyncJobs;
  readonly #pool: PwshSessionPool;
  #jobsChanged?: () => void;
  #seq = 0;

  constructor(asyncJobs: HostAsyncJobs, pool: PwshSessionPool) {
    this.#asyncJobs = asyncJobs;
    this.#pool = pool;
  }

  setJobsChangedListener(listener: (() => void) | undefined): void {
    this.#jobsChanged = listener;
  }

  getJob(id: string): PwshJob | undefined {
    return this.#jobs.get(id);
  }

  listJobs(): PwshJob[] {
    return Array.from(this.#jobs.values());
  }

  startJob(options: StartJobOptions): PwshJob {
    const controller = new AbortController();
    // One pooled session per job, disposed on settle — the same isolation the
    // private manager gives a background command.
    const sessionKey = `async-host:${++this.#seq}`;
    const timeoutSec = options.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
    const settled = Promise.withResolvers<PwshJob>();
    const job: PwshJob = {
      // Replaced by the host's job id below, and by the run context's id if the
      // manager starts the body before `register` returns.
      id: `pwsh_pending_${this.#seq}`,
      command: options.command,
      sessionKey,
      cwd: options.cwd,
      startTime: Date.now(),
      timeoutSec,
      status: "running",
      output: "",
      intent: options.intent,
      resolveIntent: options.resolveIntent,
      abortController: controller,
      settled: settled.promise,
    };

    let id: string;
    try {
      id = this.#asyncJobs.register(
        "pwsh",
        jobLabel(job),
        async (ctx) => {
          job.id = ctx.jobId;
          // Both signals matter: the host's (jobs-sheet cancel, session
          // shutdown) and ours (`kill` called before the host answered).
          const signal = AbortSignal.any([ctx.signal, controller.signal]);
          try {
            await runPwshJob(job, this.#pool, options, signal, () => {
              const tail =
                job.output.length > PROGRESS_TAIL_CHARS
                  ? job.output.slice(-PROGRESS_TAIL_CHARS)
                  : job.output;
              void ctx
                .reportProgress(tail, {
                  output: tail,
                  async: { state: "running", jobId: ctx.jobId, type: "pwsh" },
                })
                .catch(() => {});
            });
            // A cancelled job keeps the manager's `cancelled` status and its
            // delivery suppressed; throwing is how the body reports that.
            if (job.status === "killed") throw new Error("Cancelled.");
            if (job.status === "failed") {
              throw new Error(job.error ?? "PowerShell command failed.");
            }
            return jobResultText(job);
          } finally {
            settled.resolve(job);
            // Each record keeps up to 1 MB of output; without this the map
            // grows for the process lifetime (the private manager bounds it).
            pruneSettledJobs(this.#jobs, () => false);
            this.#jobsChanged?.();
          }
        },
        {
          process: {
            command: options.command,
            cwd: options.cwd,
            pids: () => this.#pool.pidFor(sessionKey),
          },
        },
      );
    } catch (error) {
      // Registering can fail (session running-job cap). Nothing was queued, so
      // the caller must not keep a record: drop the aborted controller's job.
      controller.abort();
      throw error;
    }
    job.id = id;
    this.#jobs.set(id, job);
    this.#jobsChanged?.();
    return job;
  }

  /**
   * Kill through the host so the job settles as `cancelled` (no failure aside,
   * no stray "command failed" delivery) and the jobs sheet sees the same state.
   */
  killJob(id: string): PwshJob | undefined {
    const job = this.#jobs.get(id);
    if (!job) return undefined;
    if (job.status === "running") {
      job.status = "killed";
      job.abortController.abort();
      this.#asyncJobs.cancel(id);
      this.#pool.dispose(job.sessionKey);
      this.#jobsChanged?.();
    }
    return job;
  }

  async waitJob(
    id: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<{ job: PwshJob; outcome: PwshWaitOutcome } | undefined> {
    const job = this.#jobs.get(id);
    if (!job) return undefined;
    if (job.status !== "running") return { job, outcome: "settled" };

    let onAbort: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const aborted = new Promise<"aborted">((resolve) => {
        if (signal?.aborted) {
          resolve("aborted");
          return;
        }
        if (!signal) return;
        onAbort = () => resolve("aborted");
        signal.addEventListener("abort", onAbort, { once: true });
      });
      const timedOut = new Promise<"timeout">((resolve) => {
        if (!Number.isFinite(timeoutMs)) return;
        timer = setTimeout(() => resolve("timeout"), Math.max(0, timeoutMs));
      });
      const outcome = await Promise.race([
        job.settled.then(() => "settled" as const),
        aborted,
        timedOut,
      ]);
      return { job, outcome };
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  disposeAll(): void {
    for (const job of this.#jobs.values()) {
      if (job.status !== "running") continue;
      job.status = "killed";
      job.abortController.abort();
      this.#asyncJobs.cancel(job.id);
      this.#pool.dispose(job.sessionKey);
    }
    this.#jobs.clear();
    this.#jobsChanged?.();
  }
}
