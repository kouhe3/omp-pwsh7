/**
 * Host-backed pwsh background jobs.
 *
 * omp's session can expose a scoped async-job surface (`ctx.asyncJobs`) that
 * lets an extension register jobs which ride the same lifecycle as the built-in
 * `bash`/`task`/`eval` jobs: a row in the jobs sheet with progress and the live
 * pid, the session's running-job cap, cancellation from either side, and
 * completion delivery that wakes the model. The published omp 18.20 host does
 * not expose it (18.10 did), so the tool falls back to its own
 * {@link PwshJobManager}; this runtime is only selected when the surface is
 * present and complete.
 *
 * Delivery ownership moves to the host: the job body returns the result text and
 * the manager posts the `async-result` aside. A `wait` therefore reports the
 * settled state and leaves the payload to that delivery instead of inlining an
 * output the model is about to receive anyway (`resultDelivery: "host"`).
 *
 * The registration shape is kept locally as a reserved interface: omp 18.10
 * exposed it, the published 18.20 host does not, and the structural copy keeps
 * the extension compiling — and runtime-degrading — without pinning a fork's
 * types. The current host still has the *read* half —
 * `ctx.getAsyncJobSnapshot()` — which this module also wraps: host-owned jobs
 * (bash/task/eval) stay addressable by id and are rendered as
 * `read proc://<id>` rows instead of pretending this tool can control them.
 */
import type {
  AsyncJobSnapshot,
  AsyncJobSnapshotItem,
} from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import {
  type AdoptJobOptions,
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
import { sanitizeTerminalText } from "./sanitize";
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
 * Reserved registration surface: the scoped async-job API omp 18.10 exposed on
 * `ExtensionContext`. `cancel` is required by the feature test — a job whose
 * only kill path were the extension's own abort would surface as a *failed* job
 * and would have its error delivered, so a host without it gets the private
 * manager instead of a half-working mode.
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

/**
 * Latest-omp read surface: the session's own jobs exactly as the jobs sheet and
 * `proc://` see them. Unlike the registration half this exists in the published
 * host, so it is the live fallback whenever a job id the extension does not own
 * is looked up.
 */
export interface HostJobsReader {
  getAsyncJobSnapshot(options?: {
    recentLimit?: number;
  }): AsyncJobSnapshot | null;
}

/** Feature-detect the read surface on a tool/command context. */
export function hostJobsReader(ctx: unknown): HostJobsReader | undefined {
  const candidate = ctx as Partial<HostJobsReader> | null | undefined;
  return typeof candidate?.getAsyncJobSnapshot === "function"
    ? (candidate as HostJobsReader)
    : undefined;
}

/**
 * The session's host jobs (bash/task/eval), running first, then recent. Empty
 * when the host has no read surface or the snapshot call fails — callers treat
 * this as "no extra jobs", never as an error.
 */
export function hostJobEntries(
  ctx: unknown,
  recentLimit = 20,
): AsyncJobSnapshotItem[] {
  const reader = hostJobsReader(ctx);
  if (!reader) return [];
  try {
    const snapshot = reader.getAsyncJobSnapshot({ recentLimit });
    return snapshot ? [...snapshot.running, ...snapshot.recent] : [];
  } catch {
    return [];
  }
}

/** Look up one host job by id, for ids this extension does not own. */
export function findHostJob(
  ctx: unknown,
  id: string,
): AsyncJobSnapshotItem | undefined {
  return hostJobEntries(ctx, 50).find((job) => job.id === id);
}

/** One-line pointer to the host's own view of a job it owns. */
export function hostJobHint(
  job: AsyncJobSnapshotItem,
  action?: string,
): string {
  const control =
    action === "kill"
      ? `write { path: "proc://${job.id}/kill" } to stop it`
      : action === "wait"
        ? "wait for it with the generic wait tool"
        : `read proc://${job.id} for its status, output, and streams`;
  return `Job '${job.id}' is a host background job (${job.type}, ${job.status}); ${control}.`;
}

/**
 * `proc://` roster rows for host jobs this tool does not own. Host-backed pwsh
 * jobs are excluded: their ids are already in the pwsh listing, and listing
 * them twice would suggest two different control paths.
 */
export function hostJobsReport(
  ctx: unknown,
  exclude: ReadonlySet<string> = new Set(),
  now = Date.now(),
): string {
  const jobs = hostJobEntries(ctx).filter((job) => !exclude.has(job.id));
  if (jobs.length === 0) return "";
  const lines = ["Host jobs (read proc://<id>):"];
  for (const job of jobs) {
    const elapsed = ((job.endTime ?? now) - job.startTime) / 1000;
    const marker =
      job.status === "running"
        ? "●"
        : job.status === "cancelled"
          ? "◼"
          : job.status === "completed"
            ? "✓"
            : "✗";
    lines.push(
      `  ${marker} ${job.id} ${job.status} ${elapsed.toFixed(1)}s — ${sanitizeTerminalText(job.label)}`,
    );
  }
  return lines.join("\n");
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

  pidsFor(job: PwshJob): readonly number[] {
    return this.#pool.pidFor(job.sessionKey);
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
   * Take over a running foreground command by registering a host job that waits
   * for it: the host owns delivery, the jobs sheet gets a row with the session's
   * live pid, and a jobs-sheet cancel mirrors onto the command's controller.
   * `undefined` when the host is at its running-job cap — the foreground call
   * then keeps waiting for its own command.
   */
  adoptJob(options: AdoptJobOptions): PwshJob | undefined {
    const job: PwshJob = {
      // Replaced by the host's id below, and by the run context's id if the
      // manager starts the body before `register` returns.
      id: `pwsh_pending_${++this.#seq}`,
      command: options.command,
      sessionKey: options.sessionKey,
      cwd: options.cwd,
      startTime: options.startTime,
      timeoutSec: options.timeoutSec,
      status: "running",
      output: options.output,
      intent: options.intent,
      resolveIntent: options.resolveIntent,
      abortController: options.abortController,
      settled: options.settled,
    };

    let id: string;
    try {
      id = this.#asyncJobs.register(
        "pwsh",
        jobLabel(job),
        async (ctx) => {
          job.id = ctx.jobId;
          const unsubscribe = options.onProgress((tail) => {
            void ctx
              .reportProgress(tail, {
                output: tail,
                async: { state: "running", jobId: ctx.jobId, type: "pwsh" },
              })
              .catch(() => {});
          });
          // The host's cancel paths (jobs sheet, session teardown) abort
          // `ctx.signal`. The command belongs to the foreground call, whose
          // controller is the only thing that can kill it, so mirror the abort
          // there instead of acting on the signal here.
          const mirrorAbort = () =>
            options.abortController.abort(ctx.signal.reason);
          if (ctx.signal.aborted) mirrorAbort();
          else
            ctx.signal.addEventListener("abort", mirrorAbort, { once: true });
          try {
            await options.settled;
          } finally {
            unsubscribe();
            ctx.signal.removeEventListener("abort", mirrorAbort);
            pruneSettledJobs(this.#jobs, () => false);
            this.#jobsChanged?.();
          }
          // A cancelled job keeps the manager's `cancelled` status and its
          // delivery suppressed; throwing is how the body reports that.
          if (job.status === "killed") throw new Error("Cancelled.");
          if (job.status === "failed") {
            throw new Error(job.error ?? "PowerShell command failed.");
          }
          return jobResultText(job);
        },
        {
          process: {
            command: options.command,
            cwd: options.cwd,
            // The command runs on the session it already owned (the persistent
            // REPL session), so report that process rather than a job worker.
            pids: () => this.#pool.pidFor(options.sessionKey),
          },
        },
      );
    } catch {
      // Registering fails at the running-job cap. Nothing was queued, so the
      // caller keeps its command and waits it out.
      return undefined;
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
