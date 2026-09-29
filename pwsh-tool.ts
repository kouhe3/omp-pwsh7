/**
 * `pwsh` - persistent PowerShell 7 session tool for OMP.
 *
 * One long-lived `pwsh -File runner.ps1` subprocess per (cwd, session) key.
 * State (variables, modules, location) survives across calls, so module
 * imports are paid once. Protocol and runner live in `session.ts`/`runner.ps1`.
 * Card rendering lives in `card.ts`, syntax highlighting in `syntax.ts`.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
// Host-owned pi-tui instance (OMP rewrites every `@oh-my-pi/pi-*` specifier in
// extension sources to the module it already has loaded). Required because the
// framed-block mark is a module-private Symbol: a copy from our own
// node_modules would mark the component with a symbol the host never checks.
import { markFramedBlockComponent } from "@oh-my-pi/pi-tui/render";
import {
  TOOL_LABEL,
  callTitle,
  commandBlock,
  renderCard,
  renderPendingRow,
  type PwshRenderOptions,
  type PwshRenderResult,
  type Theme,
} from "./card";
import { PwshSessionPool, type PwshRunResult } from "./session";
import { PwshJobManager, type PwshJob, type PwshJobStatus } from "./job";

const DEFAULT_TIMEOUT_SEC = 120;
const MIN_TIMEOUT_SEC = 1;
const MAX_TIMEOUT_SEC = 3600;
const DEFAULT_WIDTH = 200;
const MIN_WIDTH = 40;
const MAX_WIDTH = 4096;
const STREAM_PREVIEW_CHARS = 50 * 1024;

export interface PwshParams {
  command?: string;
  /**
   * Model-declared intent (`INTENT_FIELD`), the harness-wide `i` argument: a
   * capitalized 2-6 word present participle. It becomes the card title, so the
   * header describes what the call is doing instead of naming the tool.
   */
  i?: string;
  cwd?: string;
  env?: Record<string, string>;
  format?: "text" | "json";
  width?: number;
  timeout?: number;
  session?: string;
  async?: boolean;
  jobId?: string;
  action?: "status" | "kill" | "wait";
}

export interface PwshDetails {
  cwd: string;
  sessionKey: string;
  format: "text" | "json";
  timeoutSec: number;
  exitCode?: number | null;
  timedOut?: boolean;
  dead?: boolean;
  streaming?: boolean;
  error?: string | null;
  output?: string | null;
  wallTimeMs: number;
  async?: boolean;
  jobId?: string;
  status?: PwshJobStatus;
  command?: string;
}

interface SessionLike {
  run(
    req: {
      code: string;
      env?: Record<string, string>;
      width?: number;
      format?: "text" | "json";
    },
    opts: {
      timeoutMs?: number;
      signal?: AbortSignal;
      onChunk?: (text: string) => void;
    },
  ): Promise<PwshRunResult>;
}

interface PwshApi {
  getOrCreate(key: string, cwd?: string): SessionLike;
}

/** Session key: cwd + explicit session name. */
export function buildSessionKey(cwd: string, session?: string): string {
  return `${cwd}\n${session ?? ""}`;
}

type PwshUpdate = {
  content: Array<{ type: "text"; text: string }>;
  details?: Partial<PwshDetails>;
};

/** Core execute body - split out for smoke tests. */
export async function runPwsh(
  params: PwshParams,
  api: PwshApi,
  onUpdate?: (update: PwshUpdate) => void,
  signal?: AbortSignal,
): Promise<{ text: string; details: PwshDetails; isError?: boolean }> {
  const cwd = params.cwd ?? process.cwd();
  if (!params.command) {
    const error = "Missing command to execute.";
    return {
      text: error,
      details: emptyDetails(params, cwd, error),
      isError: true,
    };
  }
  const started = Date.now();
  const command = params.command;
  onUpdate?.({
    content: [
      {
        type: "text",
        text: `[pwsh] running in session ${buildSessionKey(cwd, params.session)}…`,
      },
    ],
  });

  // Validate cwd before spawning so a bad path fails fast instead of
  // producing a confusing spawn error.
  const cwdStat = await Bun.file(cwd)
    .stat()
    .catch(() => null);
  if (!cwdStat || !cwdStat.isDirectory()) {
    const error = !cwdStat
      ? `Working directory does not exist: ${cwd}`
      : `Working directory is not a directory: ${cwd}`;
    return {
      text: error,
      details: emptyDetails(params, cwd, error),
      isError: true,
    };
  }

  const timeoutSec = normalizeTimeout(params.timeout);
  const width = normalizeWidth(params.width);
  const format = params.format === "json" ? "json" : "text";
  const sessionKey = buildSessionKey(cwd, params.session);
  const session = api.getOrCreate(sessionKey, cwd);
  let streamPreview = "";

  const runResult = await session.run(
    {
      code: command,
      env: params.env,
      width,
      format,
    },
    {
      timeoutMs: timeoutSec === 0 ? undefined : timeoutSec * 1000,
      signal,
      onChunk:
        format === "text"
          ? (chunk) => {
              streamPreview = (streamPreview + chunk).slice(
                -STREAM_PREVIEW_CHARS,
              );
              onUpdate?.({
                content: [{ type: "text", text: streamPreview }],
                details: {
                  cwd,
                  sessionKey,
                  format,
                  timeoutSec,
                  streaming: true,
                  output: streamPreview,
                  wallTimeMs: Date.now() - started,
                },
              });
            }
          : undefined,
    },
  );

  const wallTimeMs = Date.now() - started;
  const details: PwshDetails = {
    cwd,
    sessionKey,
    format,
    timeoutSec,
    wallTimeMs,
  };

  if (runResult.busy) {
    return {
      text:
        runResult.error ??
        "session busy (another command is running); retry later",
      details,
      isError: true,
    };
  }
  if (runResult.dead) {
    details.dead = true;
    details.error = runResult.error;
    details.output = runResult.partialOutput;
    return {
      text: `pwsh process died (session rebuilt)${runResult.error ? `: ${runResult.error}` : ""}${
        runResult.partialOutput ? `\n${runResult.partialOutput}` : ""
      }`,
      details,
      isError: true,
    };
  }
  if (runResult.timedOut) {
    details.timedOut = true;
    details.output = runResult.partialOutput;
    return {
      text: `Command timed out (${timeoutSec}s; process tree killed)${runResult.partialOutput ? `\n${runResult.partialOutput}` : ""}`,
      details,
      isError: true,
    };
  }
  if (runResult.aborted) {
    details.output = runResult.partialOutput;
    const isMessageInterruption =
      signal?.reason === Symbol.for("pi-agent-core.tool-interrupt");
    const msg = isMessageInterruption
      ? "Command interrupted by message."
      : "Command cancelled.";
    return {
      text: `${msg}${runResult.partialOutput ? `\nPartial output:\n${runResult.partialOutput}` : ""}`,
      details,
    };
  }

  const resp = runResult.response;
  details.exitCode = resp?.exitCode ?? null;
  details.error = resp?.error ?? null;
  details.output = resp?.output ?? null;

  // Full output passes through untruncated: the host's wrapToolWithMetaNotice
  // spill (tools.artifactSpillThreshold, default 50 KB) saves oversized
  // results to an artifact and appends `Read artifact://N for full output`,
  // so nothing is lost. Trailing blank lines from Out-String are trimmed so
  // the wire text stays compact.
  let body: string;
  if (resp?.error) {
    body = `Execution error: ${resp.error}`;
  } else if (resp?.output) {
    body = resp.output.replace(/\r\n/g, "\n").replace(/\r/g, "").trimEnd();
  } else {
    body = "(no output)";
  }
  const notices: string[] = [];
  if (resp?.exitCode !== null && resp?.exitCode !== undefined) {
    notices.push(`Exit code: ${resp.exitCode}`);
  }
  notices.push(`Wall time: ${(wallTimeMs / 1000).toFixed(2)} seconds`);
  return {
    text: `${body}\n\n${notices.join(" · ")}`,
    details,
    isError: Boolean(resp?.error),
  };
}

function emptyDetails(
  params: PwshParams,
  cwd: string,
  error: string,
): PwshDetails {
  return {
    cwd,
    sessionKey: buildSessionKey(cwd, params.session),
    format: params.format === "json" ? "json" : "text",
    timeoutSec: normalizeTimeout(params.timeout),
    error,
    wallTimeMs: 0,
  };
}

function normalizeTimeout(value: number | undefined): number {
  if (value === 0) return 0;
  if (value === undefined) return DEFAULT_TIMEOUT_SEC;
  return Math.max(
    MIN_TIMEOUT_SEC,
    Math.min(MAX_TIMEOUT_SEC, Math.round(value)),
  );
}

/** Shared status/wait snapshot text for one job (terminal or in-flight). */
function jobSnapshotText(job: PwshJob): string {
  const durationSec = ((job.endTime ?? Date.now()) - job.startTime) / 1000;
  return [
    `Job '${job.id}' (${job.status}, ${durationSec.toFixed(1)}s)`,
    job.exitCode != null ? `Exit code: ${job.exitCode}` : undefined,
    job.output.trim() ? `Output:\n${job.output.trim()}` : undefined,
    job.error ? `Error: ${job.error}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function normalizeWidth(value: number | undefined): number {
  if (value === undefined) return DEFAULT_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(value)));
}

/** Details payload shared by job-control, status, and wait results. */
function jobDetails(
  job: PwshJob,
  params: PwshParams,
  cwd: string,
  error = job.error ?? "",
): PwshDetails {
  return {
    ...emptyDetails(params, cwd, error),
    async: true,
    jobId: job.id,
    status: job.status,
    command: job.command,
    output: job.output,
    exitCode: job.exitCode,
    timeoutSec: job.timeoutSec,
    wallTimeMs: (job.endTime ?? Date.now()) - job.startTime,
  };
}

// ---------------------------------------------------------------------------
// Tool definition: schema, execution, and the render hooks that draw the card
// through `card.ts` (host instance of pi-tui, see the import at the top).
// ---------------------------------------------------------------------------

export function definePwshTool(pi: ExtensionAPI) {
  // Ensure the background job manager is initialized and bound to the host ExtensionAPI.
  getJobManager(pi);
  const z = pi.zod;
  return {
    name: "pwsh",
    label: TOOL_LABEL,
    description:
      "Execute commands in a persistent PowerShell 7 session. Modules/variables/cwd persist across calls (Import-Module is paid once). Supports text (Out-String) and JSON (ConvertTo-Json) output formats.",
    // 常驻顶层 schema：避免工具被藏进 xd:// 设备目录，模型可直接调用。
    loadMode: "essential" as const,
    // Merge call+result into one frame like built-in tools: the pending call
    // renders the command block; once the result lands the same slot redraws
    // as the full frame (status title + command + output). Read by
    // ToolExecutionComponent via the wrapper proxy (tool-execution.ts:1012).
    mergeCallAndResult: true as boolean,
    parameters: z.object({
      i: z
        .string()
        .optional()
        .describe(
          "Intent for this call, capitalized 2-6 words as a present participle (e.g. 'List large files'); shown as the card title",
        ),
      command: z
        .string()
        .optional()
        .describe(
          "PowerShell script to execute (multi-line / script blocks supported); required when starting a command",
        ),
      async: z
        .boolean()
        .optional()
        .describe(
          "run command asynchronously in the background; returns immediately with jobId and delivers results automatically",
        ),
      jobId: z
        .string()
        .optional()
        .describe("job ID of an async background job to inspect or stop"),
      action: z
        .enum(["status", "kill", "wait"])
        .optional()
        .describe(
          "action for background job: 'status' to inspect, 'kill' to stop, 'wait' to block until it settles (timeout bounds the wait, default 120s, 0 waits indefinitely)",
        ),
      cwd: z
        .string()
        .optional()
        .describe(
          "working directory; Set-Location inside the session may drift",
        ),
      env: z
        .record(z.string(), z.string())
        .optional()
        .describe("extra environment variables (restored after execution)"),
      format: z
        .enum(["text", "json"])
        .optional()
        .describe("text=Out-String (default); json=ConvertTo-Json -Depth 100"),
      width: z
        .number()
        .optional()
        .describe("Out-String width, default 200, range 40-4096"),
      timeout: z
        .number()
        .optional()
        .describe(
          `timeout in seconds; 0 disables; default ${DEFAULT_TIMEOUT_SEC}; range ${MIN_TIMEOUT_SEC}-${MAX_TIMEOUT_SEC}`,
        ),
      session: z
        .string()
        .optional()
        .describe("custom session name to isolate the process pool"),
    }),
    async execute(
      _toolCallId: string,
      params: PwshParams,
      signal: AbortSignal | undefined,
      onUpdate:
        | ((update: { content: Array<{ type: "text"; text: string }> }) => void)
        | undefined,
    ): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: PwshDetails;
      isError?: boolean;
    }> {
      const pool = getPool();
      const jm = getJobManager(pi);
      const cwd = params.cwd ?? process.cwd();

      if (params.action && !params.jobId) {
        const err = `Missing jobId for action '${params.action}'.`;
        return {
          content: [{ type: "text" as const, text: err }],
          details: emptyDetails(params, cwd, err),
          isError: true,
        };
      }

      // Branch 1: Job control via jobId
      if (params.jobId) {
        // Job handle shared by all three actions. Resolving it up front matters
        // for the wait: `disposeAll` (session shutdown) clears the job map, so a
        // lookup taken after the settle would report not-found for a job the
        // waiter already observed. A missing job falls through to the shared
        // not-found below.
        let job = jm.getJob(params.jobId);

        if (params.action === "kill" && job) {
          if (job.status !== "running") {
            const text = `Job '${job.id}' is not running (status: ${job.status}).`;
            return {
              content: [{ type: "text" as const, text }],
              details: jobDetails(job, params, cwd, ""),
            };
          }
          const killed = jm.killJob(params.jobId)!;
          const text = `PowerShell background job '${killed.id}' killed.`;
          return {
            content: [{ type: "text" as const, text }],
            details: jobDetails(killed, params, cwd, ""),
          };
        }

        // action: "wait" - block until settlement, the wait budget, or abort.
        // Only the still-running outcome is wait-specific; a settled job and an
        // unknown id both fall through to the shared snapshot below.
        if (params.action === "wait") {
          const budgetSec = normalizeTimeout(params.timeout);
          const waited = await jm.waitJob(
            params.jobId,
            signal,
            budgetSec > 0 ? budgetSec * 1000 : Infinity,
          );
          if (waited && waited.job.status === "running") {
            // Wait budget elapsed or the caller aborted: detach and snapshot.
            const pendingJob = waited.job;
            const elapsedSec = (
              ((pendingJob.endTime ?? Date.now()) - pendingJob.startTime) /
              1000
            ).toFixed(1);
            const reason =
              waited.outcome === "aborted"
                ? "Wait aborted"
                : `Wait timed out after ${budgetSec}s`;
            const text = [
              `${reason}; job '${pendingJob.id}' is still running (${elapsedSec}s).`,
              pendingJob.output.trim()
                ? `Output so far:\n${pendingJob.output.trim()}`
                : undefined,
            ]
              .filter(Boolean)
              .join("\n");
            return {
              content: [{ type: "text" as const, text }],
              details: jobDetails(pendingJob, params, cwd, ""),
            };
          }
        }

        // Default, action: "status", or a wait that already settled
        if (!job) {
          const err = `Job '${params.jobId}' not found.`;
          return {
            content: [{ type: "text" as const, text: err }],
            details: emptyDetails(params, cwd, err),
            isError: true,
          };
        }

        const text = jobSnapshotText(job);

        return {
          content: [{ type: "text" as const, text }],
          details: jobDetails(job, params, cwd),
          isError: job.status === "failed",
        };
      }

      // Branch 2: Async execution
      if (params.async === true) {
        if (!params.command) {
          const err = "Missing command to execute in async mode.";
          return {
            content: [{ type: "text" as const, text: err }],
            details: emptyDetails(params, cwd, err),
            isError: true,
          };
        }
        const job = jm.startJob({
          command: params.command,
          cwd,
          intent: params.i,
          env: params.env,
          format: params.format,
          width: params.width,
          timeoutSec: normalizeTimeout(params.timeout),
        });

        const text = [
          `Background job '${job.id}' started.`,
          `Command: ${job.command}`,
          `The result will be delivered automatically upon completion. Wait with { jobId: "${job.id}", action: "wait" }, inspect with { jobId: "${job.id}" }, or stop with { jobId: "${job.id}", action: "kill" }.`,
        ].join("\n");

        return {
          content: [{ type: "text" as const, text }],
          details: {
            ...emptyDetails(params, cwd, ""),
            async: true,
            jobId: job.id,
            status: "running",
            command: job.command,
            output: "",
            timeoutSec: job.timeoutSec,
          },
        };
      }

      // Branch 3: Synchronous foreground execution
      const out = await runPwsh(params, pool, onUpdate, signal);
      const content = [{ type: "text" as const, text: out.text }];
      return { content, details: out.details, isError: out.isError };
    },
    onSession(event: { reason: string }): void {
      // Session lifecycle cleanup: kill pwsh subprocesses on shutdown so no
      // orphan processes survive the omp session.
      if (event.reason === "shutdown") {
        getJobManager().disposeAll();
        getPool().disposeAll();
      }
    },
    renderCall(args: PwshParams, options: PwshRenderOptions, theme: Theme) {
      // While the model is still emitting the arguments, show the inline pending
      // row (grep/glob style: one line, no card) instead of a frame — a
      // half-streamed command must not draw a card, and neither the intent nor the
      // cwd have finished arriving. Marked as framed so the host adds neither
      // padding nor its state tint; the leading column is ours, like the
      // `Text(text, 1, 0)` those built-ins return.
      if (options.argsComplete !== true) {
        return markFramedBlockComponent({
          render: () => [renderPendingRow(theme, callTitle(options, args))],
        });
      }
      return markFramedBlockComponent({
        render: (width: number) =>
          commandBlock(theme, width, args.command ?? "", {
            label: callTitle(options, args),
            cwd: args.cwd,
            closed: true,
            expanded: options.expanded === true,
          }),
      });
    },
    renderResult(
      result: PwshRenderResult,
      options: PwshRenderOptions,
      theme: Theme,
      args?: PwshParams,
    ) {
      const d = result.details;
      if (!d) {
        // Partial/pending result (onUpdate fired, no details yet): args are
        // complete by now, so keep the command block visible.
        return markFramedBlockComponent({
          render: (width: number) =>
            commandBlock(theme, width, args?.command ?? "", {
              label: callTitle(options, args),
              cwd: args?.cwd,
              closed: true,
              expanded: options.expanded === true,
            }),
        });
      }
      const displayDetails = {
        ...d,
        timeoutSec: d.timeoutSec ?? normalizeTimeout(args?.timeout),
      };
      return markFramedBlockComponent({
        render: (width: number) => {
          const effectiveCommand = args?.command || d.command || "";
          return renderCard(theme, width, effectiveCommand, displayDetails, {
            label: callTitle(options, args),
            // Only an explicit `cwd` reaches the title; the session cwd is implied.
            cwd: args?.cwd,
            expanded: options.expanded === true,
            isPartial: options.isPartial === true,
            isError: result.isError === true,
          });
        },
      });
    },
  };
}

// Module-level pool so the tool keeps sessions across calls within the process.
let pool: PwshSessionPool | null = null;

function getPool(): PwshSessionPool {
  if (!pool) pool = new PwshSessionPool();
  return pool;
}

let jobManager: PwshJobManager | null = null;

export function getJobManager(pi?: ExtensionAPI): PwshJobManager {
  if (!jobManager) {
    jobManager = new PwshJobManager(getPool(), pi);
  } else if (pi) {
    jobManager.setExtensionApi(pi);
  }
  return jobManager;
}

export function resetJobManager(): void {
  if (jobManager) {
    jobManager.disposeAll();
    jobManager = null;
  }
}
