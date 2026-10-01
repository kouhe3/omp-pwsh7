/**
 * Background job management for pwsh.
 *
 * Each async job runs in an isolated worker session (`async:<jobId>`),
 * so long-running or blocking scripts do not tie up the default REPL session.
 * Completed jobs automatically deliver an `async-result` aside notification
 * to wake the model without polling.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { PwshSessionPool } from "./session";

/** Maximum output characters retained in-memory per background job (1 MB tail window). */
const MAX_JOB_OUTPUT_CHARS = 1024 * 1024;

/** Maximum output characters included in the async completion message sent to the agent prompt (16 KB). */
const MAX_DELIVERY_OUTPUT_CHARS = 16 * 1024;

/**
 * Settled jobs kept addressable by id. Each retains up to 1 MB of output, and a
 * long session that keeps starting background work would otherwise grow the job
 * map without bound; the newest `N` by settle time stay inspectable.
 */
export const MAX_RETAINED_SETTLED_JOBS = 32;

const DEFAULT_TIMEOUT_SEC = 120;

export type PwshJobStatus = "running" | "completed" | "failed" | "killed";

export interface PwshJob {
  readonly id: string;
  readonly command: string;
  readonly sessionKey: string;
  readonly cwd: string;
  readonly startTime: number;
  readonly timeoutSec: number;
  endTime?: number;
  status: PwshJobStatus;
  exitCode?: number | null;
  output: string;
  outputTruncated?: boolean;
  error?: string | null;
  intent?: string;
  /**
   * Late intent lookup. `i` is stripped from the tool's parameters before
   * `execute` runs (intent tracing), so the label is only known once the
   * `tool_execution_start` hook has recorded it for that call id — by delivery
   * time, always.
   */
  readonly resolveIntent?: () => string | undefined;
  readonly abortController: AbortController;
  readonly settled: Promise<PwshJob>;
}

export type PwshWaitOutcome = "settled" | "timeout" | "aborted";

export interface StartJobOptions {
  command: string;
  cwd: string;
  intent?: string;
  resolveIntent?: () => string | undefined;
  env?: Record<string, string>;
  format?: "text" | "json";
  width?: number;
  timeoutSec?: number;
}

/** Marker per job status, matching the card's status language (`card.ts`). */
const JOB_MARKERS: Record<PwshJobStatus, string> = {
  running: "●",
  completed: "✓",
  failed: "✗",
  killed: "◼",
};

/** Settled jobs listed by {@link jobsReport}. */
const RECENT_JOB_ROWS = 5;

/** Label budget in the listing, so one long command cannot flood the notice. */
const JOB_LABEL_CHARS = 60;

/** Whole/partial seconds, the same granularity the job card shows. */
function formatJobDuration(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

/** Display label for one job: the declared intent, else its first command line. */
function jobLabel(job: PwshJob): string {
  const declared = job.intent?.trim() || job.resolveIntent?.()?.trim();
  if (declared) return declared;
  return job.command.split("\n", 1)[0]?.trim() || job.id;
}

/** One listing row: marker, id, status, elapsed time, clamped label. */
function jobRow(job: PwshJob, now: number): string {
  const label = jobLabel(job).replace(/\s+/g, " ");
  const shown =
    label.length > JOB_LABEL_CHARS
      ? `${label.slice(0, JOB_LABEL_CHARS - 3)}...`
      : label;
  const elapsed = (job.endTime ?? now) - job.startTime;
  return `  ${JOB_MARKERS[job.status]} ${job.id} ${job.status} ${formatJobDuration(elapsed)} — ${shown}`;
}

/**
 * `/pwsh` listing: running jobs first, then the most recently settled ones.
 * One row per job — marker, id, elapsed time, label.
 */
export function jobsReport(
  jobs: readonly PwshJob[],
  now = Date.now(),
): string {
  if (jobs.length === 0) {
    return 'No PowerShell background jobs. Start one with pwsh { command: "…", async: true }.';
  }
  const running = jobs.filter((job) => job.status === "running");
  const settled = jobs
    .filter((job) => job.status !== "running")
    .sort((a, b) => (b.endTime ?? 0) - (a.endTime ?? 0))
    .slice(0, RECENT_JOB_ROWS);
  const lines = [`PowerShell jobs — ${running.length} running`];
  for (const job of [...running, ...settled]) lines.push(jobRow(job, now));
  return lines.join("\n");
}

export class PwshJobManager {
  readonly #jobs = new Map<string, PwshJob>();
  /** Jobs with a waiter blocked in `waitJob`; any entry suppresses that job's completion aside. */
  readonly #waiters = new WeakMap<PwshJob, number>();
  readonly #pool: PwshSessionPool;
  #pi?: ExtensionAPI;
  #jobsChanged?: () => void;

  constructor(pool: PwshSessionPool, pi?: ExtensionAPI) {
    this.#pool = pool;
    this.#pi = pi;
  }

  setExtensionApi(pi: ExtensionAPI): void {
    this.#pi = pi;
  }

  /**
   * Notified whenever the retained job set or a job's status changes — the
   * footer count and the `/pwsh` listing read the pool on demand, so they only
   * need a nudge to refresh.
   */
  setJobsChangedListener(listener: (() => void) | undefined): void {
    this.#jobsChanged = listener;
  }

  generateJobId(): string {
    const randomHex = Math.random().toString(16).slice(2, 10);
    return `pwsh_${randomHex}`;
  }

  getJob(id: string): PwshJob | undefined {
    return this.#jobs.get(id);
  }

  listJobs(): PwshJob[] {
    return Array.from(this.#jobs.values());
  }

  startJob(options: StartJobOptions): PwshJob {
    const id = this.generateJobId();
    const sessionKey = `async:${id}`;
    const abortController = new AbortController();
    const startTime = Date.now();

    const timeoutSec =
      options.timeoutSec !== undefined
        ? options.timeoutSec
        : DEFAULT_TIMEOUT_SEC;

    let resolveSettled!: (job: PwshJob) => void;
    const settled = new Promise<PwshJob>((resolve) => {
      resolveSettled = resolve;
    });

    const job: PwshJob = {
      id,
      command: options.command,
      sessionKey,
      cwd: options.cwd,
      startTime,
      timeoutSec,
      status: "running",
      output: "",
      intent: options.intent,
      resolveIntent: options.resolveIntent,
      abortController,
      settled,
    };

    this.#jobs.set(id, job);
    this.#jobsChanged?.();

    // Launch worker execution asynchronously in the background
    void (async () => {
      const session = this.#pool.getOrCreate(sessionKey, options.cwd);
      try {
        const res = await session.run(
          {
            code: options.command,
            env: options.env,
            width: options.width,
            format: options.format,
          },
          {
            timeoutMs: timeoutSec > 0 ? timeoutSec * 1000 : undefined,
            signal: abortController.signal,
            onChunk: (chunk) => {
              if (job.output.length + chunk.length > MAX_JOB_OUTPUT_CHARS) {
                job.output = (job.output + chunk).slice(-MAX_JOB_OUTPUT_CHARS);
                job.outputTruncated = true;
              } else {
                job.output += chunk;
              }
            },
          },
        );

        if (abortController.signal.aborted || job.status === "killed") {
          job.status = "killed";
          if (!job.output && res.partialOutput) {
            job.output = res.partialOutput;
          }
        } else if (res.timedOut) {
          job.status = "failed";
          job.error = "Command timed out.";
          if (!job.output && res.partialOutput) {
            job.output = res.partialOutput;
          }
        } else if (res.dead || res.error) {
          job.status = "failed";
          job.error = res.error ?? "Subprocess failed.";
          if (!job.output && res.partialOutput) {
            job.output = res.partialOutput;
          }
        } else {
          const resp = res.response;
          job.exitCode = resp?.exitCode;
          if (resp?.output && !job.output) {
            if (resp.output.length > MAX_JOB_OUTPUT_CHARS) {
              job.output = resp.output.slice(-MAX_JOB_OUTPUT_CHARS);
              job.outputTruncated = true;
            } else {
              job.output = resp.output;
            }
          }
          if (resp?.error) {
            job.error = resp.error;
          }
          const hasError = Boolean(job.error || (job.exitCode != null && job.exitCode !== 0));
          job.status = hasError ? "failed" : "completed";
        }
      } catch (err) {
        if (job.status !== "killed") {
          job.status = "failed";
          job.error = err instanceof Error ? err.message : String(err);
        }
      } finally {
        job.endTime = Date.now();
        this.#pool.dispose(job.sessionKey);
        resolveSettled(job);

        // Auto-deliver completion notice via pi.sendMessage if available and not killed manually
        if (job.status !== "killed" && !this.#waiters.has(job) && this.#pi?.sendMessage) {
          this.#deliverCompletion(job);
        }
        this.#pruneSettledJobs();
        this.#jobsChanged?.();
      }
    })();

    return job;
  }

  /**
   * Drop the oldest settled jobs once more than {@link MAX_RETAINED_SETTLED_JOBS}
   * are retained, newest by settle time first. Running jobs and jobs with a
   * waiter attached stay: the waiter already holds the handle and must be able
   * to return it, and a wait that outlives its job still has to find it.
   */
  #pruneSettledJobs(): void {
    const settled: PwshJob[] = [];
    for (const job of this.#jobs.values()) {
      if (job.status === "running" || this.#waiters.has(job)) continue;
      settled.push(job);
    }
    if (settled.length <= MAX_RETAINED_SETTLED_JOBS) return;
    settled.sort((a, b) => (a.endTime ?? 0) - (b.endTime ?? 0));
    for (const job of settled.slice(
      0,
      settled.length - MAX_RETAINED_SETTLED_JOBS,
    )) {
      this.#jobs.delete(job.id);
    }
  }

  killJob(id: string): PwshJob | undefined {
    const job = this.#jobs.get(id);
    if (!job) return undefined;
    if (job.status === "running") {
      job.status = "killed";
      job.abortController.abort();
      this.#pool.dispose(job.sessionKey);
      job.endTime = Date.now();
      this.#jobsChanged?.();
    }
    return job;
  }

  /**
   * Block until the job settles, `timeoutMs` elapses, or `signal` aborts.
   * While a waiter is attached the completion aside is suppressed: the waiter
   * returns the result itself, so the model never receives it twice. A timeout
   * or abort detaches immediately, so a later completion still delivers.
   */
  async waitJob(
    id: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<{ job: PwshJob; outcome: PwshWaitOutcome } | undefined> {
    const job = this.#jobs.get(id);
    if (!job) return undefined;
    this.#waiters.set(job, (this.#waiters.get(job) ?? 0) + 1);
    let onAbort: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (job.status !== "running") return { job, outcome: "settled" };

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
      const remaining = (this.#waiters.get(job) ?? 1) - 1;
      if (remaining > 0) this.#waiters.set(job, remaining);
      else this.#waiters.delete(job);
    }
  }

  disposeAll(): void {
    for (const job of this.#jobs.values()) {
      if (job.status === "running") {
        job.status = "killed";
        job.abortController.abort();
        this.#pool.dispose(job.sessionKey);
      }
    }
    this.#jobs.clear();
    this.#jobsChanged?.();
  }

  #deliverCompletion(job: PwshJob): void {
    const durationMs = (job.endTime ?? Date.now()) - job.startTime;
    const durationSec = (durationMs / 1000).toFixed(1);
    const cleanLabel = jobLabel(job).replace(/\s+/g, " ").trim();
    const label =
      cleanLabel.length > 40 ? `${cleanLabel.slice(0, 37)}...` : cleanLabel;

    let outputSection: string | undefined;
    const trimmedOutput = job.output.trim();
    if (trimmedOutput.length > 0) {
      if (trimmedOutput.length > MAX_DELIVERY_OUTPUT_CHARS) {
        const tail = trimmedOutput.slice(-MAX_DELIVERY_OUTPUT_CHARS);
        outputSection = `Output (last ${MAX_DELIVERY_OUTPUT_CHARS} chars):\n${tail}\n... [output truncated (${trimmedOutput.length} chars total); inspect with { jobId: "${job.id}" }]`;
      } else {
        outputSection = `Output:\n${trimmedOutput}`;
      }
    }

    const summaryLines = [
      `PowerShell background job '${job.id}' ${job.status} (${durationSec}s).`,
      job.exitCode != null ? `Exit code: ${job.exitCode}` : undefined,
      outputSection,
      job.error?.trim() ? `Error:\n${job.error.trim()}` : undefined,
    ].filter(Boolean);

    try {
      this.#pi?.sendMessage(
        {
          customType: "async-result",
          content: summaryLines.join("\n"),
          // `display: false` is the payload default, and the host paints an
          // `async-result` message only when it is set (`ui-helpers.ts`:
          // `if (message.display)`), so without it the completion reached the
          // model but never the transcript. `display: true` reuses the host's
          // native "Background job completed" card.
          display: true,
          details: {
            jobId: job.id,
            type: "pwsh",
            label,
            durationMs,
          },
        },
        {
          deliverAs: "aside",
          triggerTurn: true,
        },
      );
    } catch {
      // Best-effort delivery; host session might be tearing down
    }
  }
}
