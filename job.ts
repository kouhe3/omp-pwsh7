/**
 * Background job management for pwsh.
 *
 * Each async job runs in an isolated worker session (`async:<jobId>`),
 * so long-running or blocking scripts do not tie up the default REPL session.
 * Completed jobs automatically deliver an `async-result` aside notification
 * to wake the model without polling.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { PwshRunResult, PwshSessionPool } from "./session";

/** Maximum output characters retained in-memory per background job (1 MB tail window). */
export const MAX_JOB_OUTPUT_CHARS = 1024 * 1024;

/** Maximum output characters included in the async completion message sent to the agent prompt (16 KB). */
const MAX_DELIVERY_OUTPUT_CHARS = 16 * 1024;

/**
 * Settled jobs kept addressable by id. Each retains up to 1 MB of output, and a
 * long session that keeps starting background work would otherwise grow the job
 * map without bound; the newest `N` by settle time stay inspectable.
 */
export const MAX_RETAINED_SETTLED_JOBS = 32;

export const DEFAULT_TIMEOUT_SEC = 120;

export type PwshJobStatus = "running" | "completed" | "failed" | "killed";

export interface PwshJob {
  /** Assigned by the runtime that starts the job (host job id when host-backed). */
  id: string;
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

/**
 * Background-job surface the pwsh tool drives, implemented twice: the private
 * {@link PwshJobManager} (stock omp) and {@link HostPwshJobs} (omp's scoped
 * async-job manager, when the session exposes one). The tool and the renderers
 * only ever see {@link PwshJob} records, so both runtimes report the same way.
 */
export interface PwshJobsRuntime {
  /**
   * Who delivers a settled job's result: `"self"` — this runtime posts the
   * `async-result` aside and a wait that consumed the result suppresses it;
   * `"host"` — the host manager owns delivery, so a wait reports state only.
   */
  readonly resultDelivery: "self" | "host";
  setJobsChangedListener(listener: (() => void) | undefined): void;
  listJobs(): readonly PwshJob[];
  getJob(id: string): PwshJob | undefined;
  startJob(options: StartJobOptions): PwshJob;
  killJob(id: string): PwshJob | undefined;
  waitJob(
    id: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<{ job: PwshJob; outcome: PwshWaitOutcome } | undefined>;
  disposeAll(): void;
}

/**
 * Fold a finished session run into the job record: status, exit code, output
 * fallback, error. Shared by both runtimes, so a job's outcome does not depend
 * on which one is running it.
 */
export function finishPwshJob(
  job: PwshJob,
  res: PwshRunResult,
  aborted: boolean,
): void {
  if (aborted || job.status === "killed") {
    job.status = "killed";
    if (!job.output && res.partialOutput) job.output = res.partialOutput;
    return;
  }
  if (res.timedOut) {
    job.status = "failed";
    job.error = "Command timed out.";
    if (!job.output && res.partialOutput) job.output = res.partialOutput;
    return;
  }
  if (res.dead || res.error) {
    job.status = "failed";
    job.error = res.error ?? "Subprocess failed.";
    if (!job.output && res.partialOutput) job.output = res.partialOutput;
    return;
  }
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
  if (resp?.error) job.error = resp.error;
  const hasError = Boolean(
    job.error || (job.exitCode != null && job.exitCode !== 0),
  );
  job.status = hasError ? "failed" : "completed";
}

/** Append streamed output to a job, keeping the retained tail window bounded. */
export function appendPwshJobOutput(job: PwshJob, chunk: string): void {
  if (job.output.length + chunk.length > MAX_JOB_OUTPUT_CHARS) {
    job.output = (job.output + chunk).slice(-MAX_JOB_OUTPUT_CHARS);
    job.outputTruncated = true;
  } else {
    job.output += chunk;
  }
}

/**
 * Run one background job in its own pooled session and fold the outcome into
 * its record. Both runtimes call this, so a job's terminal state (killed,
 * timed out, failed, completed) does not depend on which one started it.
 *
 * Never rejects: a thrown run is recorded as the job's failure. Callers that
 * only await settlement, and host bodies that must report the final state to
 * their own manager, can therefore always rely on the record being final.
 */
export async function runPwshJob(
  job: PwshJob,
  pool: PwshSessionPool,
  options: StartJobOptions,
  signal: AbortSignal,
  onChunk?: (chunk: string, job: PwshJob) => void,
): Promise<void> {
  try {
    const session = pool.getOrCreate(job.sessionKey, options.cwd);
    const res = await session.run(
      {
        code: options.command,
        env: options.env,
        width: options.width,
        format: options.format,
      },
      {
        timeoutMs: job.timeoutSec > 0 ? job.timeoutSec * 1000 : undefined,
        signal,
        onChunk: (chunk) => {
          appendPwshJobOutput(job, chunk);
          onChunk?.(chunk, job);
        },
      },
    );
    finishPwshJob(job, res, signal.aborted);
  } catch (err) {
    if (job.status !== "killed") {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
    }
  } finally {
    job.endTime = Date.now();
    pool.dispose(job.sessionKey);
  }
}

/**
 * Drop the oldest settled jobs once more than {@link MAX_RETAINED_SETTLED_JOBS}
 * are retained, newest by settle time first — each record keeps up to
 * {@link MAX_JOB_OUTPUT_CHARS} of output, so an unbounded map is a leak.
 * Running jobs stay; `keep` protects a record a runtime still needs (the
 * private manager holds jobs with a waiter blocked on them, since that waiter
 * must be able to return the handle).
 */
export function pruneSettledJobs(
  jobs: Map<string, PwshJob>,
  keep: (job: PwshJob) => boolean,
): void {
  const settled: PwshJob[] = [];
  for (const job of jobs.values()) {
    if (job.status === "running" || keep(job)) continue;
    settled.push(job);
  }
  if (settled.length <= MAX_RETAINED_SETTLED_JOBS) return;
  settled.sort((a, b) => (a.endTime ?? 0) - (b.endTime ?? 0));
  for (const job of settled.slice(
    0,
    settled.length - MAX_RETAINED_SETTLED_JOBS,
  )) {
    jobs.delete(job.id);
  }
}

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
export function jobLabel(job: PwshJob): string {
  const declared = job.intent?.trim() || job.resolveIntent?.()?.trim();
  if (declared) return declared;
  return job.command.split("\n", 1)[0]?.trim() || job.id;
}

/**
 * Completion text for one settled job: status, duration, exit code, output,
 * error. `maxChars` caps the inlined output — the private manager passes its
 * prompt cap; host-backed delivery passes none and lets the host spill an
 * oversized payload to an artifact.
 */
export function jobResultText(job: PwshJob, maxChars?: number): string {
  const durationSec = (
    ((job.endTime ?? Date.now()) - job.startTime) /
    1000
  ).toFixed(1);
  const trimmedOutput = job.output.trim();
  let outputSection: string | undefined;
  if (trimmedOutput.length > 0) {
    if (maxChars != null && trimmedOutput.length > maxChars) {
      const tail = trimmedOutput.slice(-maxChars);
      outputSection = `Output (last ${maxChars} chars):\n${tail}\n... [output truncated (${trimmedOutput.length} chars total); inspect with { jobId: "${job.id}" }]`;
    } else {
      outputSection = `Output:\n${trimmedOutput}`;
    }
  }
  return [
    `PowerShell background job '${job.id}' ${job.status} (${durationSec}s).`,
    job.exitCode != null ? `Exit code: ${job.exitCode}` : undefined,
    outputSection,
    job.error?.trim() ? `Error:\n${job.error.trim()}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
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

export class PwshJobManager implements PwshJobsRuntime {
  readonly resultDelivery = "self" as const;
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
    void runPwshJob(job, this.#pool, options, abortController.signal).then(
      () => {
        resolveSettled(job);

        // Auto-deliver completion notice via pi.sendMessage if available and not killed manually
        if (
          job.status !== "killed" &&
          !this.#waiters.has(job) &&
          this.#pi?.sendMessage
        ) {
          this.#deliverCompletion(job);
        }
        pruneSettledJobs(this.#jobs, (settled) => this.#waiters.has(settled));
        this.#jobsChanged?.();
      },
    );

    return job;
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
    const cleanLabel = jobLabel(job).replace(/\s+/g, " ").trim();
    const label =
      cleanLabel.length > 40 ? `${cleanLabel.slice(0, 37)}...` : cleanLabel;

    try {
      this.#pi?.sendMessage(
        {
          customType: "async-result",
          content: jobResultText(job, MAX_DELIVERY_OUTPUT_CHARS),
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
