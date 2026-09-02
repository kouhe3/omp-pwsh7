/**
 * Persistent pwsh session: spawns `pwsh -File runner.ps1` and speaks the
 * line-based base64-JSON protocol. One process per session key; state
 * (variables, modules, cwd) survives across requests.
 */

export interface PwshRequest {
  id: number;
  code: string;
  env?: Record<string, string>;
  width?: number;
  format?: "text" | "json";
}

export interface PwshResponse {
  type?: "result";
  id: number;
  output?: string | null;
  error?: string | null;
  exitCode?: number | null;
}

interface PwshChunk {
  type: "chunk";
  id: number;
  text: string;
}

export interface PwshRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onChunk?: (text: string) => void;
}

export interface PwshRunResult {
  response?: PwshResponse;
  /** True when the command was killed by its deadline (not a user abort). */
  timedOut?: boolean;
  /** True when killed via abort signal. */
  aborted?: boolean;
  /** Process died mid-request (crash/EOF) - session is dead. */
  dead?: boolean;
  /** Session was busy and the caller gave up waiting for the slot. */
  busy?: boolean;
  /** Diagnostic message when dead (spawn failure, etc.). */
  error?: string;
  /** Partial output captured before the kill. */
  partialOutput?: string;
}

/** Path to the runner script, cached on disk next to the extension. */
function runnerScriptPath(): string {
  // Resolve relative to this module: extensions/pwsh7/session.ts -> runner.ps1
  return `${import.meta.dir}/runner.ps1`;
}

function resolvePwshExecutable(envPath?: string): string {
  return envPath?.trim() || "pwsh";
}

const KILL_GRACE_MS = 1500;
/** Give up waiting for an in-flight command on the same session after this. */
const BUSY_WAIT_TIMEOUT_MS = 30_000;
/** Keep the last N chars of runner stderr for diagnostics. */
const STDERR_TAIL_CHARS = 500;
/** Handle returned by setTimeout; held per-request so it can be cleared on settle. */
type TimerHandle = ReturnType<typeof setTimeout>;

export class PwshSession {
  readonly key: string;
  #proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
  #dead = false;
  #buffer = "";
  #pending = new Map<
    number,
    {
      resolve: (r: PwshResponse) => void;
      reject: (e: Error) => void;
      onChunk?: (text: string) => void;
    }
  >();
  /** Per-request "process exited" subscribers (Bun has no event emitter on Subprocess). */
  #exitHandlers = new Set<() => void>();
  /** Persistent decoders: UTF-8 multibyte chars can straddle stream chunks. */
  #stdoutDecoder = new TextDecoder();
  #stderrDecoder = new TextDecoder();
  /**
   * Sequence start is randomized so an in-session script cannot enumerate
   * upcoming request ids and forge protocol responses (a crafted stdout line
   * `base64(JSON { id, output })` would otherwise resolve the pending request
   * with attacker-controlled content).
   */
  #nextId = 1 + ((Math.random() * 0x7ffffffe) | 0);
  #inFlight = false;
  #lastError: string | undefined;
  #stderrTail = "";

  constructor(
    key: string,
    private readonly pwshPath: string,
    private readonly runnerPath: string,
    private readonly cwd?: string,
  ) {
    this.key = key;
  }

  get dead(): boolean {
    return this.#dead;
  }

  get busy(): boolean {
    return this.#inFlight;
  }

  /** Start the pwsh subprocess if not already running. */
  start(): void {
    // #dead means the old proc was killed (timeout/abort) and is still
    // dying via taskkill - respawn instead of treating it as alive.
    if (this.#proc && !this.#dead && !this.#proc.killed) return;
    let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
    try {
      proc = Bun.spawn(
        [
          this.pwshPath,
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-File",
          this.runnerPath,
        ],
        {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          windowsHide: true,
          cwd: this.cwd,
        },
      );
    } catch (err) {
      // Spawn failure (e.g. pwsh missing) surfaces as a sync throw.
      this.#dead = true;
      this.#lastError = err instanceof Error ? err.message : String(err);
      this.#rejectAll(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.#proc = proc;
    this.#dead = false;
    // Bun's onStdout/onStderr spawn options never fire (Bun 1.3.14,
    // Windows) - read the piped streams manually instead.
    if (proc.stdout)
      void this.#pipeStream(proc.stdout, (chunk) =>
        this.#onStdout(this.#stdoutDecoder.decode(chunk, { stream: true })),
      );
    if (proc.stderr) {
      void this.#pipeStream(proc.stderr, (chunk) => {
        this.#stderrTail = (
          this.#stderrTail + this.#stderrDecoder.decode(chunk, { stream: true })
        ).slice(-STDERR_TAIL_CHARS);
      });
    }
    const handleExit = (err?: unknown) => {
      if (this.#proc !== proc) return; // superseded by a respawned proc
      this.#emitExit();
      this.#dead = true;
      if (err !== undefined) {
        this.#lastError = err instanceof Error ? err.message : String(err);
      }
      const exitErr =
        err instanceof Error
          ? err
          : new Error(this.#lastError ?? "pwsh process exited");
      this.#rejectAll(exitErr);
    };
    proc.exited.then(() => handleExit(), handleExit);
  }

  /** Pull chunks from a piped Subprocess stream until it closes. */
  async #pipeStream(
    stream: ReadableStream<Uint8Array>,
    onChunk: (chunk: Uint8Array) => void,
  ): Promise<void> {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        onChunk(value);
      }
    } catch {
      // Stream aborted by kill - session death is handled via `exited`.
    } finally {
      reader.releaseLock();
    }
  }

  #addExitHandler(handler: () => void): () => void {
    this.#exitHandlers.add(handler);
    return () => {
      this.#exitHandlers.delete(handler);
    };
  }

  #emitExit(): void {
    for (const handler of [...this.#exitHandlers]) handler();
  }

  /** Run one command. Serialized per session: concurrent callers wait. */
  async run(
    request: Omit<PwshRequest, "id">,
    options: PwshRunOptions = {},
  ): Promise<PwshRunResult> {
    if (this.#inFlight) {
      const waited = await this.#waitForIdle();
      if (!waited) {
        return {
          busy: true,
          error: "session busy (another command is still running); retry later",
        };
      }
    }
    this.#inFlight = true;
    try {
      return await this.#runLocked(request, options);
    } finally {
      this.#inFlight = false;
    }
  }

  async #waitForIdle(): Promise<boolean> {
    const deadline = Date.now() + BUSY_WAIT_TIMEOUT_MS;
    while (this.#inFlight) {
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 10));
    }
    return true;
  }

  async #runLocked(
    request: Omit<PwshRequest, "id">,
    options: PwshRunOptions,
  ): Promise<PwshRunResult> {
    this.start();
    if (this.#dead || !this.#proc) {
      return {
        dead: true,
        error: this.#lastError ?? "pwsh process is not running",
        partialOutput: this.#stderrTail || undefined,
      };
    }

    const id = this.#nextId++;
    const payload: PwshRequest = { id, ...request };
    const line = Buffer.from(JSON.stringify(payload), "utf8").toString(
      "base64",
    );
    const proc = this.#proc;

    this.#latestOutput = "";
    const response = new Promise<PwshResponse>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, onChunk: options.onChunk });
    });

    proc.stdin.write(line + "\n");

    let timeoutTimer: TimerHandle | undefined;
    let settled = false;
    let offExit: () => void = () => {};
    const killAndMark = (kind: "timeout" | "aborted"): void => {
      const live = this.#proc;
      if (!live) return;
      this.#dead = true;
      // Kill the whole process tree: pwsh may have spawned children.
      const killer = Bun.spawn(
        ["taskkill", "/PID", String(live.pid), "/T", "/F"],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          windowsHide: true,
        },
      );
      killer.exited.finally(() => {
        if (this.#proc === live) this.#proc = null;
      });
      // Fallback: direct kill if taskkill fails to deliver within grace.
      setTimeout(() => {
        if (this.#proc === live) {
          try {
            live.kill();
          } catch {
            /* already gone */
          }
          this.#proc = null;
        }
      }, KILL_GRACE_MS).unref();
      if (kind === "aborted")
        options.signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      killAndMark("aborted");
      this.#pending.delete(id);
      offExit();
      resolveResult({ aborted: true, partialOutput: this.#latestOutput });
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    let resolveResult = (_r: PwshRunResult): void => {};
    const resultPromise = new Promise<PwshRunResult>((res) => {
      resolveResult = res;
    });

    // Timeout: kill the tree, then settle with timedOut.
    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        killAndMark("timeout");
        this.#pending.delete(id);
        offExit();
        resolveResult({ timedOut: true, partialOutput: this.#latestOutput });
      }, options.timeoutMs);
    }

    const onExit = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      this.#pending.delete(id);
      resolveResult({ dead: true, partialOutput: this.#latestOutput });
    };
    offExit = this.#addExitHandler(onExit);

    response
      .then((r) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        offExit();
        resolveResult({ response: r });
      })
      .catch(() => {
        /* handled by exit path */
      });

    return resultPromise;
  }

  #latestOutput = "";
  #onStdout(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const nl = this.#buffer.indexOf("\n");
      if (nl < 0) break;
      const line = this.#buffer.slice(0, nl).trim();
      this.#buffer = this.#buffer.slice(nl + 1);
      if (!line) continue;
      let frame: PwshResponse | PwshChunk;
      try {
        frame = JSON.parse(Buffer.from(line, "base64").toString("utf8")) as
          PwshResponse | PwshChunk;
      } catch {
        continue; // garbage line (e.g. startup noise) - ignore
      }
      const pending = this.#pending.get(frame.id);
      if (frame.type === "chunk") {
        this.#latestOutput += frame.text;
        if (pending?.onChunk) {
          try {
            pending.onChunk(frame.text);
          } catch {
            // A UI update failure must not corrupt the protocol reader.
          }
        }
        continue;
      }
      this.#latestOutput = frame.output ?? frame.error ?? this.#latestOutput;
      if (pending) {
        this.#pending.delete(frame.id);
        pending.resolve(frame);
      }
    }
  }

  #rejectAll(err: Error): void {
    for (const [, p] of this.#pending) p.reject(err);
    this.#pending.clear();
  }

  /** Dispose: kill the process tree and drop the session. */
  async dispose(): Promise<void> {
    const live = this.#proc;
    this.#proc = null;
    if (live && live.pid != null && !live.killed) {
      const killer = Bun.spawn(
        ["taskkill", "/PID", String(live.pid), "/T", "/F"],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          windowsHide: true,
        },
      );
      await new Promise<void>((res) => {
        killer.exited.finally(res);
        setTimeout(res, KILL_GRACE_MS).unref();
      });
    }
    this.#dead = true;
  }
}

/** Pool of persistent sessions keyed by sessionKey. */
export class PwshSessionPool {
  #sessions = new Map<string, PwshSession>();
  #pwshPath: string;
  #runnerPath: string;

  constructor(options: { pwshPath?: string; runnerPath?: string } = {}) {
    this.#pwshPath = resolvePwshExecutable(options.pwshPath);
    this.#runnerPath = options.runnerPath ?? runnerScriptPath();
  }

  getOrCreate(key: string, cwd?: string): PwshSession {
    let session = this.#sessions.get(key);
    if (!session || session.dead) {
      session = new PwshSession(key, this.#pwshPath, this.#runnerPath, cwd);
      this.#sessions.set(key, session);
    }
    return session;
  }

  disposeAll(): void {
    for (const s of this.#sessions.values()) void s.dispose();
    this.#sessions.clear();
  }
}
