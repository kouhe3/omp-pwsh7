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
  readonly abortController: AbortController;
  readonly settled: Promise<PwshJob>;
}

export interface StartJobOptions {
  command: string;
  cwd: string;
  intent?: string;
  env?: Record<string, string>;
  format?: "text" | "json";
  width?: number;
  timeoutSec?: number;
}

export class PwshJobManager {
  readonly #jobs = new Map<string, PwshJob>();
  readonly #pool: PwshSessionPool;
  #pi?: ExtensionAPI;

  constructor(pool: PwshSessionPool, pi?: ExtensionAPI) {
    this.#pool = pool;
    this.#pi = pi;
  }

  setExtensionApi(pi: ExtensionAPI): void {
    this.#pi = pi;
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
      abortController,
      settled,
    };

    this.#jobs.set(id, job);

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
        if (job.status !== "killed" && this.#pi?.sendMessage) {
          this.#deliverCompletion(job);
        }
      }
    })();

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
    }
    return job;
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
  }

  #deliverCompletion(job: PwshJob): void {
    const durationMs = (job.endTime ?? Date.now()) - job.startTime;
    const durationSec = (durationMs / 1000).toFixed(1);
    const rawLabel =
      job.intent && job.intent.trim().length > 0
        ? job.intent
        : job.command;
    const cleanLabel = rawLabel.replace(/\s+/g, " ").trim();
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
