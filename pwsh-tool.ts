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

const DEFAULT_TIMEOUT_SEC = 120;
const MIN_TIMEOUT_SEC = 1;
const MAX_TIMEOUT_SEC = 3600;
const DEFAULT_WIDTH = 200;
const MIN_WIDTH = 40;
const MAX_WIDTH = 4096;
const STREAM_PREVIEW_CHARS = 50 * 1024;

export interface PwshParams {
  command: string;
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
  const started = Date.now();
  const command = params.command;
  const cwd = params.cwd ?? process.cwd();
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
    return {
      text: "Command cancelled",
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

function normalizeWidth(value: number | undefined): number {
  if (value === undefined) return DEFAULT_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(value)));
}

// ---------------------------------------------------------------------------
// Tool definition: schema, execution, and the render hooks that draw the card
// through `card.ts` (host instance of pi-tui, see the import at the top).
// ---------------------------------------------------------------------------

export function definePwshTool(pi: ExtensionAPI) {
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
        .describe(
          "PowerShell script to execute (multi-line / script blocks supported)",
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
    ) {
      const pool = getPool();
      const out = await runPwsh(params, pool, onUpdate, signal);
      const content = [{ type: "text" as const, text: out.text }];
      return { content, details: out.details, isError: out.isError };
    },
    onSession(event: { reason: string }): void {
      // Session lifecycle cleanup: kill pwsh subprocesses on shutdown so no
      // orphan processes survive the omp session.
      if (event.reason === "shutdown") {
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
        render: (width: number) =>
          renderCard(theme, width, args?.command ?? "", displayDetails, {
            label: callTitle(options, args),
            // Only an explicit `cwd` reaches the title; the session cwd is implied.
            cwd: args?.cwd,
            expanded: options.expanded === true,
            isPartial: options.isPartial === true,
            isError: result.isError === true,
          }),
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
