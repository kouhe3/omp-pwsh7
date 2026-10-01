import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { definePwshTool, getJobManager, resetJobManager } from "./pwsh-tool";
import { MAX_RETAINED_SETTLED_JOBS, PwshJobManager } from "./job";
import type { PwshSessionPool } from "./session";

// Mock schema builder similar to zod
const schema = () => {
  const self: Record<string, unknown> = {
    describe() {
      return self;
    },
    optional() {
      return self;
    },
  };
  return self;
};

const zStub = {
  string: schema,
  number: schema,
  enum: schema,
  object: (shape: Record<string, unknown>) => ({ ...schema(), shape }),
  record: schema,
  boolean: schema,
};

const theme = {
  fg: (_color: string, text: string) => `\x1b[38;5;244m${text}\x1b[0m`,
  boxRound: {
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
    horizontal: "─",
    vertical: "│",
  },
  boxSharp: { teeLeft: "┤", teeRight: "├", horizontal: "─" },
};

type SentMessage = { message: unknown; options: unknown };

/** Every footer/notification call the tool made through its UI context. */
interface UiRecorder {
  statuses: Array<[key: string, text: string | undefined]>;
  notices: string[];
}

/**
 * The tool bound to a host stub that records every `sendMessage` aside. Tests
 * assert both directions: the completion notice that fires on its own, and the
 * suppression a blocked `wait` imposes. `startJob` runs a real background job
 * and returns its id plus the start result.
 */
function makeTool() {
  const sentMessages: SentMessage[] = [];
  const starts: Array<(event: unknown, ctx: unknown) => void> = [];
  const commands = new Map<
    string,
    { handler: (args: string, ctx: unknown) => Promise<void> }
  >();
  const ui: UiRecorder = { statuses: [], notices: [] };
  // One context object, like the host's session-scoped UI context. `hasUI` is
  // what the extension checks before letting a context own the footer slot.
  const ctx = {
    hasUI: true,
    ui: {
      setStatus(key: string, text: string | undefined) {
        ui.statuses.push([key, text]);
      },
      notify(message: string) {
        ui.notices.push(message);
      },
    },
  };
  const pi = {
    zod: zStub,
    sendMessage(message: unknown, options: unknown) {
      sentMessages.push({ message, options });
    },
    on(event: string, handler: (event: unknown, ctx: unknown) => void) {
      if (event === "tool_execution_start") starts.push(handler);
    },
    registerCommand(
      name: string,
      options: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) {
      commands.set(name, options);
    },
  } as unknown as ExtensionAPI;
  const tool = definePwshTool(pi);
  const startJob = async (
    callId: string,
    params: { command: string; i?: string; timeout?: number },
  ) => {
    const res = await tool.execute(
      callId,
      { ...params, async: true },
      undefined,
      undefined,
    );
    const jobId = res.details.jobId ?? "";
    expect(jobId).not.toBe("");
    return { jobId, res };
  };
  /**
   * Replay `tool_execution_start` for pwsh, as the host loop emits it. `from`
   * overrides the context (a subagent session reports `hasUI: false`).
   */
  const fireStart = (event: {
    toolCallId: string;
    args: unknown;
    intent?: string;
  }, from: unknown = ctx) => {
    for (const handler of starts) {
      handler({ toolName: "pwsh", ...event }, from);
    }
  };
  return { tool, sentMessages, startJob, fireStart, commands, ctx, ui };
}

/** Text body of a recorded aside, or "" when it is not a text message. */
function messageText(sent: SentMessage | undefined): string {
  const message = sent?.message;
  if (
    message &&
    typeof message === "object" &&
    "content" in message &&
    typeof message.content === "string"
  ) {
    return message.content;
  }
  return "";
}

test("schema accepts async, jobId, and action parameters", () => {
  const tool = definePwshTool({ zod: zStub } as never);
  const shape = (tool.parameters as unknown as { shape: Record<string, unknown> }).shape;

  expect(shape).toBeDefined();
  expect(shape.async).toBeDefined();
  expect(shape.jobId).toBeDefined();
  expect(shape.action).toBeDefined();
});

test("starts an async job immediately without blocking and delivers result via sendMessage", async () => {
  const { sentMessages, startJob } = makeTool();

  // Execute with async: true
  const { jobId, res } = await startJob("call_async_1", {
    command: "Write-Output 'async finished'",
    i: "Testing async execution",
  });

  // Tool execution returns immediately with running state
  expect(res.content[0]?.text).toContain("Background job");
  const details = res.details;
  expect(details.async).toBe(true);
  expect(details.status).toBe("running");

  // Await deterministic job settlement promise without using real wall-clock sleeps
  const job = getJobManager().getJob(jobId);
  expect(job).toBeDefined();
  await job?.settled;

  expect(sentMessages.length).toBe(1);
  const delivery = sentMessages[0]!;
  const rawMsg = delivery.message;
  expect(rawMsg).toBeDefined();
  if (rawMsg && typeof rawMsg === "object" && "customType" in rawMsg && "details" in rawMsg) {
    const msg = rawMsg as {
      customType: string;
      content: string;
      display?: boolean;
      details: { jobId: string; type: string; label?: string };
    };
    expect(msg.customType).toBe("async-result");
    // The host paints an `async-result` message only when `display` is set
    // (`ui-helpers.ts`: `if (message.display)`), so a delivery without it
    // reached the model but left the transcript empty.
    expect(msg.display).toBe(true);
    expect(msg.content).toContain("async finished");
    expect(msg.details.jobId).toBe(jobId);
    expect(msg.details.type).toBe("pwsh");
    expect(msg.details.label).toBe("Testing async execution");
  }
  expect(job?.intent).toBe("Testing async execution");
  expect(job?.timeoutSec).toBe(120);
  expect(delivery.options).toEqual({ deliverAs: "aside", triggerTurn: true });
});

test("can inspect status and kill a running async job", async () => {
  const { tool, startJob } = makeTool();

  // Start a long-running job
  const { jobId, res } = await startJob("call_async_long", {
    command: "Start-Sleep -Seconds 10; Write-Output 'done'",
  });

  // Inspect status
  const statusRes = await tool.execute(
    "call_status",
    {
      jobId,
      action: "status",
    },
    undefined,
    undefined,
  );

  expect(statusRes.content[0]?.text).toContain(jobId);
  expect(statusRes.details.status).toBe("running");

  // Kill the job
  const killRes = await tool.execute(
    "call_kill",
    {
      jobId,
      action: "kill",
    },
    undefined,
    undefined,
  );

  expect(killRes.content[0]?.text).toContain("killed");
  expect(killRes.details.status).toBe("killed");

  // Verify ergonomic card rendering for running async job (Case 1: No body, direct status bottom)
  const runningRows = tool
    .renderResult(
      { details: res.details },
      { expanded: false },
      theme,
      { command: "Start-Sleep -Seconds 10; Write-Output 'done'", async: true, jobId },
    )
    .render(80);
  const runningCard = runningRows.join("\n");

  expect(runningCard).toContain("running");
  expect(runningCard).toContain(jobId);
  // Ergonomic check: No divider followed by bottom border (no double bottom lines)
  expect(runningCard).not.toContain("├───");
  expect(runningRows[runningRows.length - 1]).toContain("running");
  expect(Bun.stripANSI(runningRows[runningRows.length - 1]!).startsWith("╰")).toBe(true);

  // Verify ergonomic card rendering for killed job (Case 1 with fallback title and command context)
  const killedRows = tool
    .renderResult(
      { details: killRes.details },
      { expanded: false },
      theme,
      { jobId, action: "kill" },
    )
    .render(80);
  const killedCard = killedRows.join("\n");

  expect(killedCard).toContain("killed");
  expect(killedCard).toContain(jobId);
  // Ergonomic check: Header intelligently reflects the action instead of generic "PowerShell 7"
  expect(killedCard).toContain(`Kill job ${jobId}`);
  // Ergonomic check: Displays the cancelled command from details even though args.command was empty
  expect(killedCard).toContain("Start-Sleep");
  // Ergonomic check: Closing line has the status directly
  expect(killedRows[killedRows.length - 1]).toContain("killed");
  expect(Bun.stripANSI(killedRows[killedRows.length - 1]!).startsWith("╰")).toBe(true);

  // Ensure all rows have exact same visual column width
  const widths = killedRows.map((r) => Bun.stringWidth(r, { countAnsiEscapeCodes: false }));
  expect(new Set(widths).size).toBe(1);
});

test("handles command interruption by message gracefully", async () => {
  const tool = definePwshTool({ zod: zStub } as never);
  const controller = new AbortController();

  // Start command and abort with message-interrupt reason
  const runPromise = tool.execute(
    "call_interrupt",
    { command: "Write-Output 'pre-interrupt'; Start-Sleep -Seconds 5; Write-Output 'post'" },
    controller.signal,
    undefined,
  );

  // Abort with TOOL_INTERRUPT_ABORT_REASON
  controller.abort(Symbol.for("pi-agent-core.tool-interrupt"));
  const res = await runPromise;

  expect(res.content[0]?.text).toContain("Command interrupted by message");
});

test("disposes worker session in pool upon job completion to prevent subprocess leaks", async () => {
  const disposedKeys: string[] = [];
  const fakePool = {
    getOrCreate: (_key: string, _cwd?: string) => ({
      run: async () => ({
        response: { output: "done", exitCode: 0 },
      }),
    }),
    dispose: (key: string) => {
      disposedKeys.push(key);
    },
  } as unknown as PwshSessionPool;

  const jm = new PwshJobManager(fakePool);
  const job = jm.startJob({ command: "Write-Output 'done'", cwd: process.cwd() });
  await job.settled;

  expect(job.status).toBe("completed");
  expect(disposedKeys).toContain(`async:${job.id}`);
});

test("retains only the newest settled jobs and evicts the oldest", async () => {
  const fakePool = {
    getOrCreate: () => ({
      run: async () => ({ response: { output: "done", exitCode: 0 } }),
    }),
    dispose: () => {},
  } as unknown as PwshSessionPool;

  const jm = new PwshJobManager(fakePool);
  const total = MAX_RETAINED_SETTLED_JOBS + 5;
  const ids: string[] = [];
  for (let index = 0; index < total; index++) {
    const job = jm.startJob({
      command: `Write-Output 'job-${index}'`,
      cwd: process.cwd(),
    });
    ids.push(job.id);
    await job.settled;
  }

  // Each job holds up to 1 MB of output, so the map is bounded by count.
  expect(jm.listJobs().length).toBe(MAX_RETAINED_SETTLED_JOBS);
  // The newest stay addressable; the oldest are gone.
  expect(jm.getJob(ids[total - 1]!)).toBeDefined();
  expect(jm.getJob(ids[total - MAX_RETAINED_SETTLED_JOBS]!)).toBeDefined();
  expect(jm.getJob(ids[0]!)).toBeUndefined();
});

test("reports accurate status and wall time when inspecting a finished job", async () => {
  const { tool, startJob } = makeTool();

  const { jobId } = await startJob("call_async_short", {
    command: "Write-Output 'quick'",
  });
  await getJobManager().getJob(jobId)?.settled;

  // Inspect status of completed job
  const statusRes = await tool.execute(
    "call_status_completed",
    { jobId, action: "status" },
    undefined,
    undefined,
  );
  expect(statusRes.details.wallTimeMs).toBeGreaterThanOrEqual(0);
  expect(statusRes.details.status).toBe("completed");

  // Attempt to kill already completed job
  const killAfterDone = await tool.execute(
    "call_kill_after_done",
    { jobId, action: "kill" },
    undefined,
    undefined,
  );
  expect(killAfterDone.content[0]?.text).toContain("is not running (status: completed)");
  expect(killAfterDone.details.status).toBe("completed");
});

test("callLabel sanitizes multi-line jobId and prevents visual frame splitting", () => {
  const tool = definePwshTool({ zod: zStub } as never);
  const multiLineJobId = "pwsh_1234\nmalicious_line";

  const rows = tool
    .renderResult(
      { details: { cwd: process.cwd(), sessionKey: "k", format: "text", timeoutSec: 120, wallTimeMs: 0 } },
      { expanded: false },
      theme,
      { jobId: multiLineJobId, action: "kill" },
    )
    .render(80);

  const header = rows[0]!;
  expect(header).not.toContain("\n");
  expect(header).toContain("Kill job pwsh_1234 malicious_line");
});

test("strips terminal control sequences from the card title, cwd, and command", () => {
  const tool = definePwshTool({ zod: zStub } as never);
  // An OSC 52 clipboard write plus a clear-screen CSI, as a model-authored
  // argument or a script's output would carry them.
  const evil = "\u001b[2J\u001b]52;c;aGk=\u0007";

  const rows = tool
    .renderCall(
      {
        i: `Kill${evil} jobs`,
        command: `Write-Output '${evil}safe'`,
        cwd: `sub${evil}dir`,
      },
      { argsComplete: true },
      theme,
    )
    .render(80);

  const card = rows.join("\n");
  const plain = Bun.stripANSI(card);
  // The sequences are gone; the text around them is not.
  expect(plain).toContain("Kill jobs");
  expect(plain).toContain("subdir");
  expect(plain).toContain("Write-Output 'safe'");
  expect(card).not.toContain("\u001b[2J");
  expect(card).not.toContain("\u001b]52;");
  expect(card).not.toContain("\u0007");
});

test("strips control sequences from job output and error text in the card body", () => {
  const tool = definePwshTool({ zod: zStub } as never);
  const evil = "\u001b]52;c;aGk=\u0007\u001b[2J";

  const rows = tool
    .renderResult(
      {
        details: {
          cwd: process.cwd(),
          sessionKey: "k",
          format: "text",
          timeoutSec: 120,
          wallTimeMs: 12,
          async: true,
          jobId: "pwsh_clean",
          status: "completed",
          output: `before ${evil} after\n`,
        },
      },
      { expanded: false },
      theme,
      { jobId: "pwsh_clean", action: "status" },
    )
    .render(80);

  const card = rows.join("\n");
  expect(Bun.stripANSI(card)).toContain("before  after");
  expect(card).not.toContain("\u001b]52;");
  expect(card).not.toContain("\u001b[2J");
});

test("strips control sequences from the jobId tag in the status row", () => {
  const tool = definePwshTool({ zod: zStub } as never);
  const evilJobId = "pwsh_x\u001b[2J\u001b]52;c;aGk=\u0007";

  const rows = tool
    .renderResult(
      {
        details: {
          cwd: process.cwd(),
          sessionKey: "k",
          format: "text",
          timeoutSec: 120,
          wallTimeMs: 5,
          async: true,
          jobId: evilJobId,
          status: "running",
          command: "Start-Sleep 10",
          output: "",
        },
      },
      { expanded: false },
      theme,
      { jobId: evilJobId, action: "status" },
    )
    .render(80);

  const card = rows.join("\n");
  expect(card).toContain("pwsh_x");
  expect(card).not.toContain("\u001b[2J");
  expect(card).not.toContain("\u001b]52;");
  expect(card).not.toContain("\u0007");
});

test("renders failed async job with failed indicator rather than false completed", () => {
  const tool = definePwshTool({ zod: zStub } as never);
  const rows = tool
    .renderResult(
      { details: { cwd: process.cwd(), sessionKey: "k", format: "text", timeoutSec: 120, wallTimeMs: 1500, async: true, jobId: "pwsh_fail", status: "failed" } },
      { expanded: false },
      theme,
      { jobId: "pwsh_fail", action: "status" },
    )
    .render(80);

  const card = rows.join("\n");
  expect(card).toContain("failed");
  expect(card).not.toContain("✓ completed");
});

test("injects pi into existing jobManager singleton and sends completion", async () => {
  // Simulate early access without pi (e.g. shutdown hook or inspect before tool run)
  const earlyJm = getJobManager();
  expect(earlyJm).toBeDefined();

  // Now define tool with valid pi
  const { sentMessages, startJob } = makeTool();
  const { jobId } = await startJob("call_early_singleton", {
    command: "Write-Output 'singleton notified'",
  });
  await getJobManager().getJob(jobId)?.settled;

  expect(sentMessages.length).toBeGreaterThan(0);
  expect(messageText(sentMessages[0])).toContain("singleton notified");
});

test("truncates large job output in deliverCompletion prompt to prevent context overflow", async () => {
  const { sentMessages, startJob } = makeTool();
  // Emit 30,000 characters
  const { jobId } = await startJob("call_large_output", {
    command: "'A' * 30000",
  });
  await getJobManager().getJob(jobId)?.settled;

  expect(sentMessages.length).toBe(1);
  const content = messageText(sentMessages[0]);
  expect(content).toContain("output truncated");
  expect(content.length).toBeLessThan(20000);
});

test("preserves original timeoutSec when inspecting job status", async () => {
  const { tool, startJob } = makeTool();
  const { jobId } = await startJob("call_custom_timeout", {
    command: "Write-Output 'timeout test'",
    timeout: 300,
  });
  await getJobManager().getJob(jobId)?.settled;

  const statusRes = await tool.execute(
    "call_check_timeout",
    {
      jobId,
      action: "status",
    },
    undefined,
    undefined,
  );

  expect(statusRes.details?.timeoutSec).toBe(300);
});

test("rejects action 'status' when jobId is missing instead of falling through to command error", async () => {
  const tool = definePwshTool({ zod: zStub } as never);
  const res = await tool.execute(
    "call_status_no_jobid",
    { action: "status" },
    undefined,
    undefined,
  );

  expect(res.isError).toBe(true);
  expect(res.content[0]?.text).toBe("Missing jobId for action 'status'.");
});

test("returns immediately when signal is already aborted without executing command", async () => {
  const tool = definePwshTool({ zod: zStub } as never);
  const controller = new AbortController();
  controller.abort();

  const res = await tool.execute(
    "call_already_aborted",
    { command: "Write-Output 'should never run'" },
    controller.signal,
    undefined,
  );

  expect(res.content[0]?.text).toContain("Command cancelled");
});

test("normalizes default timeout to 120s and allows 0 to disable timeout", async () => {
  const { startJob } = makeTool();

  // Start with default timeout (omitted)
  const defaultStart = await startJob("call_default_timeout", {
    command: "Write-Output 'default timeout'",
  });
  expect(defaultStart.res.details?.timeoutSec).toBe(120);
  const defaultJob = getJobManager().getJob(defaultStart.jobId);
  expect(defaultJob?.timeoutSec).toBe(120);
  await defaultJob?.settled;

  // Start with 0 timeout (disabled)
  const zeroStart = await startJob("call_zero_timeout", {
    command: "Write-Output 'zero timeout'",
    timeout: 0,
  });
  expect(zeroStart.res.details?.timeoutSec).toBe(0);
  const zeroJob = getJobManager().getJob(zeroStart.jobId);
  expect(zeroJob?.timeoutSec).toBe(0);
  await zeroJob?.settled;
});

test("sanitizes async completion notification label and preserves command in startJob details", async () => {
  const { sentMessages, startJob } = makeTool();
  const multiLineCmd = "Get-Process |\n  Select-Object -First 1";
  const { jobId, res } = await startJob("call_multiline_delivery", {
    command: multiLineCmd,
    i: "   ", // whitespace only should fallback to command
  });

  expect(res.details.command).toBe(multiLineCmd);
  await getJobManager().getJob(jobId)?.settled;

  expect(sentMessages.length).toBe(1);
  const msg = sentMessages[0]?.message;
  let label: string | undefined;
  if (msg && typeof msg === "object" && "details" in msg && msg.details && typeof msg.details === "object" && "label" in msg.details) {
    label = typeof msg.details.label === "string" ? msg.details.label : undefined;
  }
  expect(label).toBeDefined();
  expect(label).not.toContain("\n");
  expect(label).toContain("Get-Process");
});

test("action 'wait' blocks until the job settles and claims the result without a duplicate aside", async () => {
  const { tool, sentMessages, startJob } = makeTool();
  const { jobId } = await startJob("call_wait_start", {
    command: "Start-Sleep -Milliseconds 500; Write-Output 'wait-finished'",
  });

  const waitRes = await tool.execute("call_wait", { jobId, action: "wait" }, undefined, undefined);

  // Terminal state proves the call blocked until settlement, not that it peeked.
  expect(waitRes.details.status).toBe("completed");
  expect(waitRes.content[0]?.text).toContain("wait-finished");
  // The explicit waiter returns the result itself; the auto-delivery must not
  // push the same output a second time as an aside.
  expect(sentMessages.length).toBe(0);
});

test("a wait timeout detaches the waiter so a later completion still delivers", async () => {
  const { tool, sentMessages, startJob } = makeTool();
  const { jobId } = await startJob("call_wait_timeout_start", {
    command: "Start-Sleep -Milliseconds 1500; Write-Output 'late-finished'",
  });

  const waitRes = await tool.execute(
    "call_wait_timeout",
    { jobId, action: "wait", timeout: 1 },
    undefined,
    undefined,
  );
  expect(waitRes.details.status).toBe("running");
  expect(waitRes.content[0]?.text).toContain("still running");
  expect(sentMessages.length).toBe(0);

  // The detached waiter must not swallow the completion notice.
  await getJobManager().getJob(jobId)?.settled;
  expect(sentMessages.length).toBe(1);
});

test("action 'wait' on an unknown job reports not found", async () => {
  const { tool } = makeTool();
  const res = await tool.execute(
    "call_wait_missing",
    { jobId: "pwsh_does_not_exist", action: "wait" },
    undefined,
    undefined,
  );
  expect(res.isError).toBe(true);
  expect(res.content[0]?.text).toContain("not found");
});

test("action 'kill' on an unknown job reports not found instead of doing nothing", async () => {
  const { tool } = makeTool();
  const res = await tool.execute(
    "call_kill_missing",
    { jobId: "pwsh_no_such_job", action: "kill" },
    undefined,
    undefined,
  );
  expect(res.isError).toBe(true);
  expect(res.content[0]?.text).toBe("Job 'pwsh_no_such_job' not found.");
});

test("renders 'Wait job <jobId>' card header when intent is omitted for action 'wait'", () => {
  const tool = definePwshTool({ zod: zStub } as never);
  const jobId = "pwsh_test_wait_label";
  const rows = tool
    .renderCall({ jobId, action: "wait" }, { argsComplete: true }, theme as never)
    .render(80);
  const header = Bun.stripANSI(rows[0] ?? "");
  expect(header).toContain(`Wait job ${jobId}`);
});

test("falls back to 'Job status <jobId>' when a jobId carries no action", () => {
  const tool = definePwshTool({ zod: zStub } as never);
  const jobId = "pwsh_test_status_label";
  const rows = tool
    .renderCall({ jobId }, { argsComplete: true }, theme as never)
    .render(80);
  expect(Bun.stripANSI(rows[0] ?? "")).toContain(`Job status ${jobId}`);
});

test("abort signal interrupts 'wait' action and detaches waiter so later completion still delivers", async () => {
  const { tool, sentMessages, startJob } = makeTool();
  const { jobId } = await startJob("call_wait_abort_start", {
    command: "Start-Sleep -Milliseconds 600; Write-Output 'aborted-wait-finished'",
  });

  const controller = new AbortController();
  const waitPromise = tool.execute(
    "call_wait_abort",
    { jobId, action: "wait" },
    controller.signal,
    undefined,
  );

  controller.abort();
  const waitRes = await waitPromise;

  expect(waitRes.details.status).toBe("running");
  expect(waitRes.content[0]?.text).toContain("Wait aborted");
  expect(waitRes.content[0]?.text).toContain("still running");
  expect(sentMessages.length).toBe(0);

  await getJobManager().getJob(jobId)?.settled;
  expect(sentMessages.length).toBe(1);
});

test("action 'wait' with timeout: 0 waits indefinitely until job completion", async () => {
  const { tool, sentMessages, startJob } = makeTool();
  const { jobId } = await startJob("call_wait_zero_start", {
    command: "Start-Sleep -Milliseconds 300; Write-Output 'zero-timeout-finished'",
  });

  const waitRes = await tool.execute(
    "call_wait_zero",
    { jobId, action: "wait", timeout: 0 },
    undefined,
    undefined,
  );

  expect(waitRes.details.status).toBe("completed");
  expect(waitRes.content[0]?.text).toContain("zero-timeout-finished");
  expect(sentMessages.length).toBe(0);
});

test("action 'wait' on an already settled job returns the shared snapshot without a new aside", async () => {
  const { tool, sentMessages, startJob } = makeTool();
  const { jobId } = await startJob("call_wait_settled_start", {
    command: "Write-Output 'settled-before-wait'",
  });

  await getJobManager().getJob(jobId)?.settled;
  // The job completed with no waiter attached, so the aside went out once.
  expect(sentMessages.length).toBe(1);

  const waitRes = await tool.execute("call_wait_settled", { jobId, action: "wait" }, undefined, undefined);

  // Falls through to the shared snapshot: a wait that already settled must be
  // byte-identical to a plain status inspection of the same job.
  const statusRes = await tool.execute("call_wait_settled_status", { jobId }, undefined, undefined);
  expect(waitRes.content[0]?.text).toBe(statusRes.content[0]?.text);
  expect(waitRes.details).toEqual(statusRes.details);
  expect(waitRes.details.status).toBe("completed");
  expect(waitRes.content[0]?.text).toContain("settled-before-wait");
  expect(sentMessages.length).toBe(1);
});

test("action 'wait' surfaces a failed job as an error result instead of an aside", async () => {
  const { tool, sentMessages, startJob } = makeTool();
  const { jobId } = await startJob("call_wait_failed_start", {
    command: "throw 'boom-failed'",
  });

  const waitRes = await tool.execute("call_wait_failed", { jobId, action: "wait" }, undefined, undefined);

  // The failure is the point of waiting: it must reach the model as isError,
  // and the suppressed aside must not re-deliver it.
  expect(waitRes.details.status).toBe("failed");
  expect(waitRes.isError).toBe(true);
  expect(waitRes.content[0]?.text).toContain("boom-failed");
  expect(sentMessages.length).toBe(0);
});

test("a wait racing job-manager disposal reports the killed job instead of not-found", async () => {
  const { tool, startJob } = makeTool();
  const { jobId } = await startJob("call_wait_dispose_start", {
    command: "Start-Sleep -Seconds 10",
  });

  // Attach the waiter, then tear the manager down under it: `disposeAll` clears
  // the job map before the job settles, so the awaited handle — not a fresh
  // lookup — has to carry the result.
  const waitPromise = tool.execute(
    "call_wait_dispose",
    { jobId, action: "wait", timeout: 5 },
    undefined,
    undefined,
  );
  resetJobManager();
  const waitRes = await waitPromise;

  expect(waitRes.details.status).toBe("killed");
  expect(waitRes.isError).toBeFalsy();
  expect(waitRes.content[0]?.text).toContain(`Job '${jobId}'`);
});

test("foreground requests report a PowerShell-level exit code and keep earlier output", async () => {
  const { tool } = makeTool();
  const res = await tool.execute(
    "call_sync_exit",
    { command: "Write-Output 'sync-before-exit'; exit 3" },
    undefined,
    undefined,
  );

  // `exit N` stops the runspace pipeline before the result frame, so the code
  // only survives through the runspace host's SetShouldExit.
  expect(res.details.exitCode).toBe(3);
  expect(res.content[0]?.text).toContain("sync-before-exit");
  expect(res.content[0]?.text).toContain("Exit code: 3");
});

test("an async job that calls exit N fails with that code instead of reporting success", async () => {
  const { tool, startJob } = makeTool();
  const { jobId } = await startJob("call_exit_job_start", {
    command: "Write-Output 'job-before-exit'; exit 4",
  });

  const waitRes = await tool.execute("call_exit_job_wait", { jobId, action: "wait" }, undefined, undefined);

  expect(waitRes.details.exitCode).toBe(4);
  expect(waitRes.details.status).toBe("failed");
  expect(waitRes.isError).toBe(true);
  expect(waitRes.content[0]?.text).toContain("job-before-exit");
  expect(waitRes.content[0]?.text).toContain("Exit code: 4");
});

test("an async job that calls exit 0 still reports success", async () => {
  const { tool, startJob } = makeTool();
  const { jobId } = await startJob("call_exit_zero_start", {
    command: "Write-Output 'zero-ok'; exit 0",
  });

  const waitRes = await tool.execute("call_exit_zero_wait", { jobId, action: "wait" }, undefined, undefined);

  expect(waitRes.details.exitCode).toBe(0);
  expect(waitRes.details.status).toBe("completed");
  expect(waitRes.isError).toBeFalsy();
  expect(waitRes.content[0]?.text).toContain("zero-ok");
});

test("publishes the pwsh job count in the footer and clears it when the pool drains", async () => {
  const { startJob, fireStart, ui } = makeTool();
  // Drop anything an earlier test left running so the count is exact.
  getJobManager().disposeAll();

  const { jobId } = await startJob("call_footer_count", {
    command: "Start-Sleep -Milliseconds 400",
  });
  // The host loop does not await the event consumer before `tool.execute`, so
  // the start event arrives with the job already registered.
  fireStart({
    toolCallId: "call_footer_count",
    args: { command: "Start-Sleep -Milliseconds 400", async: true },
    intent: "Sleeping briefly",
  });

  expect(ui.statuses.at(-1)).toEqual(["pwsh-jobs", "pwsh 1 running"]);

  await getJobManager().getJob(jobId)?.settled;
  expect(ui.statuses.at(-1)).toEqual(["pwsh-jobs", undefined]);
});

test("registers /pwsh and lists running jobs with their intent", async () => {
  const { startJob, commands, ctx, ui } = makeTool();
  getJobManager().disposeAll();

  const { jobId } = await startJob("call_job_list", {
    command: "Start-Sleep -Milliseconds 400",
    i: "Sleeping briefly",
  });
  const command = commands.get("pwsh");
  expect(command).toBeDefined();

  await command!.handler("", ctx);
  const report = ui.notices.at(-1) ?? "";
  expect(report).toContain("1 running");
  expect(report).toContain(jobId);
  expect(report).toContain("Sleeping briefly");

  await getJobManager().getJob(jobId)?.settled;
});

test("labels a listed job from the intent recorded on tool_execution_start", async () => {
  const { tool, fireStart, commands, ctx, ui } = makeTool();
  getJobManager().disposeAll();

  // `i` is stripped from the parameters before `execute` runs under intent
  // tracing, so the label can only come from what the start event recorded —
  // and it has to be read by *call id*: the host may hand `execute` a rebuilt
  // copy of the args (`transformToolCallArguments`, `deobfuscateToolArguments`),
  // modelled here by two distinct objects under one id.
  const executeArgs = { command: "Start-Sleep -Milliseconds 300", async: true };
  const res = await tool.execute("call_late_intent", executeArgs, undefined, undefined);
  const jobId = res.details.jobId ?? "";
  fireStart({
    toolCallId: "call_late_intent",
    args: { ...executeArgs },
    intent: "Sleeping late",
  });
  await getJobManager().getJob(jobId)?.settled;

  await commands.get("pwsh")!.handler("", ctx);
  const report = ui.notices.at(-1) ?? "";
  expect(report).toContain(jobId);
  expect(report).toContain("Sleeping late");
});

test("a subagent context cannot hijack the footer slot from the interactive session", async () => {
  const { startJob, fireStart, ui } = makeTool();
  getJobManager().disposeAll();

  const { jobId } = await startJob("call_parent", {
    command: "Start-Sleep -Milliseconds 300",
  });
  fireStart({ toolCallId: "call_parent", args: { async: true }, intent: "Parent job" });
  expect(ui.statuses.at(-1)).toEqual(["pwsh-jobs", "pwsh 1 running"]);

  // A subagent session re-binds this module's factories and reports
  // `hasUI: false` against a no-op UI. If it owned the slot, the settling job's
  // reset would land there and the interactive footer would keep the stale
  // count. The list must stay untouched.
  const noUiCtx = { hasUI: false, ui: { setStatus: () => {} } };
  fireStart({ toolCallId: "call_child", args: { async: true }, intent: "Child job" }, noUiCtx);

  await getJobManager().getJob(jobId)?.settled;
  expect(ui.statuses.at(-1)).toEqual(["pwsh-jobs", undefined]);
});
