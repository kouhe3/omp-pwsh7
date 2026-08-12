/**
 * Persistent pwsh session: spawns `pwsh -File runner.ps1` and speaks the
 * line-based base64-JSON protocol. One process per session key; state
 * (variables, modules, cwd) survives across requests.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface PwshRequest {
	id: number;
	code: string;
	env?: Record<string, string>;
	width?: number;
	format?: "text" | "json";
}

export interface PwshResponse {
	id: number;
	output?: string | null;
	error?: string | null;
	exitCode?: number | null;
}

export interface PwshRunOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
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
	const moduleDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
	return path.join(moduleDir, "runner.ps1");
}

function resolvePwshExecutable(envPath?: string): string {
	return envPath?.trim() || "pwsh";
}

const KILL_GRACE_MS = 1500;
/** Give up waiting for an in-flight command on the same session after this. */
const BUSY_WAIT_TIMEOUT_MS = 30_000;
/** Keep the last N chars of runner stderr for diagnostics. */
const STDERR_TAIL_CHARS = 500;

export class PwshSession {
	readonly key: string;
	#proc: ChildProcess | null = null;
	#dead = false;
	#buffer = "";
	#pending = new Map<number, { resolve: (r: PwshResponse) => void; reject: (e: Error) => void }>();
	#nextId = 1;
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
		if (this.#proc && !this.#proc.killed) return;
		const proc = spawn(this.pwshPath, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", this.runnerPath], {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			cwd: this.cwd,
		});
		this.#proc = proc;
		this.#dead = false;
		proc.stdout?.setEncoding("utf8");
		proc.stderr?.setEncoding("utf8");
		proc.stdout?.on("data", chunk => this.#onStdout(chunk as string));
		proc.stderr?.on("data", chunk => {
			this.#stderrTail = ((this.#stderrTail + String(chunk)).slice(-STDERR_TAIL_CHARS));
		});
		proc.on("exit", () => {
			this.#dead = true;
			this.#rejectAll(new Error("pwsh process exited"));
		});
		proc.on("error", err => {
			this.#dead = true;
			this.#lastError = err.message;
			this.#rejectAll(err);
		});
	}

	/** Run one command. Serialized per session: concurrent callers wait. */
	async run(request: Omit<PwshRequest, "id">, options: PwshRunOptions = {}): Promise<PwshRunResult> {
		if (this.#inFlight) {
			const waited = await this.#waitForIdle();
			if (!waited) {
				return { busy: true, error: "session busy (another command is still running); retry later" };
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
			await new Promise(r => setTimeout(r, 10));
		}
		return true;
	}

	async #runLocked(request: Omit<PwshRequest, "id">, options: PwshRunOptions): Promise<PwshRunResult> {
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
		const line = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
		const proc = this.#proc;

		const response = new Promise<PwshResponse>((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
		});

		proc.stdin?.write(line + "\n");

		let timeoutTimer: NodeJS.Timeout | undefined;
		let settled = false;
		const killAndMark = (kind: "timeout" | "aborted"): void => {
			const live = this.#proc;
			if (!live) return;
			this.#dead = true;
			// Kill the whole process tree: pwsh may have spawned children.
			const killer = spawn("taskkill", ["/PID", String(live.pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
			});
			killer.on("exit", () => {
				this.#proc = null;
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
			if (kind === "aborted") options.signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = (): void => {
			if (settled) return;
			settled = true;
			killAndMark("aborted");
			this.#pending.delete(id);
			proc.removeListener("exit", onExit);
			resolveResult({ aborted: true, partialOutput: this.#latestOutput });
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });

		let resolved = false;
		let resolveResult = (_r: PwshRunResult): void => {};
		const resultPromise = new Promise<PwshRunResult>(res => {
			resolveResult = res;
		});

		// Timeout: kill the tree, then settle with timedOut.
		if (options.timeoutMs && options.timeoutMs > 0) {
			timeoutTimer = setTimeout(() => {
				if (settled) return;
				settled = true;
				killAndMark("timeout");
				this.#pending.delete(id);
				proc.removeListener("exit", onExit);
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
		proc.on("exit", onExit);

		response
			.then(r => {
				if (settled) return;
				settled = true;
				clearTimeout(timeoutTimer);
				proc.removeListener("exit", onExit);
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
			let resp: PwshResponse;
			try {
				resp = JSON.parse(Buffer.from(line, "base64").toString("utf8")) as PwshResponse;
			} catch {
				continue; // garbage line (e.g. startup noise) - ignore
			}
			this.#latestOutput = resp.output ?? resp.error ?? "";
			const pending = this.#pending.get(resp.id);
			if (pending) {
				this.#pending.delete(resp.id);
				pending.resolve(resp);
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
			const killer = spawn("taskkill", ["/PID", String(live.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
			await new Promise<void>(res => {
				killer.on("exit", () => res());
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

	/** True when the key has a live session that is not busy. */
	hasIdle(key: string): boolean {
		const s = this.#sessions.get(key);
		return s !== undefined && !s.dead && !s.busy;
	}

	disposeAll(): void {
		for (const s of this.#sessions.values()) void s.dispose();
		this.#sessions.clear();
	}
}

export { runnerScriptPath, resolvePwshExecutable };
