import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { definePwshTool, getJobManager } from "./pwsh-tool";
import { PwshJobManager } from "./job";
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

test("schema accepts async, jobId, and action parameters", () => {
  const tool = definePwshTool({ zod: zStub } as never);
  const shape = (tool.parameters as unknown as { shape: Record<string, unknown> }).shape;

  expect(shape).toBeDefined();
  expect(shape.async).toBeDefined();
  expect(shape.jobId).toBeDefined();
  expect(shape.action).toBeDefined();
});

test("starts an async job immediately without blocking and delivers result via sendMessage", async () => {
  const sentMessages: Array<{ message: unknown; options: unknown }> = [];
  const fakePi = {
    zod: zStub,
    sendMessage(message: unknown, options: unknown) {
      sentMessages.push({ message, options });
    },
  } as unknown as ExtensionAPI;

  const tool = definePwshTool(fakePi);

  // Execute with async: true
  const res = await tool.execute(
    "call_async_1",
    {
      command: "Write-Output 'async finished'",
      async: true,
      i: "Testing async execution",
    },
    undefined,
    undefined,
  );

  // Tool execution returns immediately with running state
  expect(res.content[0]?.text).toContain("Background job");
  const details = res.details;
  expect(details).toBeDefined();
  expect(details.async).toBe(true);
  expect(details.status).toBe("running");

  const jobId = details.jobId ?? "";
  expect(jobId).not.toBe("");

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
      details: { jobId: string; type: string; label?: string };
    };
    expect(msg.customType).toBe("async-result");
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
  const fakePi = {
    zod: zStub,
    sendMessage() {},
  } as unknown as ExtensionAPI;

  const tool = definePwshTool(fakePi);

  // Start a long-running job
  const startRes = await tool.execute(
    "call_async_long",
    {
      command: "Start-Sleep -Seconds 10; Write-Output 'done'",
      async: true,
    },
    undefined,
    undefined,
  );

  const jobId = startRes.details.jobId ?? "";
  expect(jobId).not.toBe("");

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
      { details: startRes.details },
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

test("reports accurate status and wall time when inspecting a finished job", async () => {
  const fakePi = {
    zod: zStub,
    sendMessage() {},
  } as unknown as ExtensionAPI;
  const tool = definePwshTool(fakePi);

  const startRes = await tool.execute(
    "call_async_short",
    { command: "Write-Output 'quick'", async: true },
    undefined,
    undefined,
  );
  const jobId = startRes.details.jobId!;
  const job = getJobManager().getJob(jobId);
  await job?.settled;

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

  const sentMessages: Array<{ message: unknown; options: unknown }> = [];
  const fakePi = {
    zod: zStub,
    sendMessage(message: unknown, options: unknown) {
      sentMessages.push({ message, options });
    },
  } as unknown as ExtensionAPI;

  // Now define tool with valid pi
  const tool = definePwshTool(fakePi);
  const res = await tool.execute(
    "call_early_singleton",
    {
      command: "Write-Output 'singleton notified'",
      async: true,
    },
    undefined,
    undefined,
  );

  const jobId = res.details?.jobId ?? "";
  const job = getJobManager().getJob(jobId);
  await job?.settled;

  expect(sentMessages.length).toBeGreaterThan(0);
  const firstMsg = sentMessages[0]?.message;
  let content = "";
  if (firstMsg && typeof firstMsg === "object" && "content" in firstMsg && typeof firstMsg.content === "string") {
    content = firstMsg.content;
  }
  expect(content).toContain("singleton notified");
});

test("truncates large job output in deliverCompletion prompt to prevent context overflow", async () => {
  const sentMessages: Array<{ message: unknown; options: unknown }> = [];
  const fakePi = {
    zod: zStub,
    sendMessage(message: unknown, options: unknown) {
      sentMessages.push({ message, options });
    },
  } as unknown as ExtensionAPI;

  const tool = definePwshTool(fakePi);
  // Emit 30,000 characters
  const res = await tool.execute(
    "call_large_output",
    {
      command: "'A' * 30000",
      async: true,
    },
    undefined,
    undefined,
  );

  const jobId = res.details?.jobId ?? "";
  const job = getJobManager().getJob(jobId);
  await job?.settled;

  expect(sentMessages.length).toBe(1);
  const firstMsg = sentMessages[0]?.message;
  let content = "";
  if (firstMsg && typeof firstMsg === "object" && "content" in firstMsg && typeof firstMsg.content === "string") {
    content = firstMsg.content;
  }
  expect(content).toContain("output truncated");
  expect(content.length).toBeLessThan(20000);
});

test("preserves original timeoutSec when inspecting job status", async () => {
  const tool = definePwshTool({ zod: zStub, sendMessage() {} } as unknown as ExtensionAPI);
  const res = await tool.execute(
    "call_custom_timeout",
    {
      command: "Write-Output 'timeout test'",
      async: true,
      timeout: 300,
    },
    undefined,
    undefined,
  );

  const jobId = res.details?.jobId ?? "";
  const job = getJobManager().getJob(jobId);
  await job?.settled;

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
  const tool = definePwshTool({ zod: zStub, sendMessage() {} } as unknown as ExtensionAPI);

  // Start with default timeout (omitted)
  const defaultRes = await tool.execute(
    "call_default_timeout",
    { command: "Write-Output 'default timeout'", async: true },
    undefined,
    undefined,
  );
  const defaultJobId = defaultRes.details?.jobId ?? "";
  const defaultJob = getJobManager().getJob(defaultJobId);
  expect(defaultJob?.timeoutSec).toBe(120);
  expect(defaultRes.details?.timeoutSec).toBe(120);
  await defaultJob?.settled;

  // Start with 0 timeout (disabled)
  const zeroRes = await tool.execute(
    "call_zero_timeout",
    { command: "Write-Output 'zero timeout'", async: true, timeout: 0 },
    undefined,
    undefined,
  );
  const zeroJobId = zeroRes.details?.jobId ?? "";
  const zeroJob = getJobManager().getJob(zeroJobId);
  expect(zeroJob?.timeoutSec).toBe(0);
  expect(zeroRes.details?.timeoutSec).toBe(0);
  await zeroJob?.settled;
});

test("sanitizes async completion notification label and preserves command in startJob details", async () => {
  const sentMessages: Array<{ message: unknown; options: unknown }> = [];
  const fakePi = {
    zod: zStub,
    sendMessage(message: unknown, options: unknown) {
      sentMessages.push({ message, options });
    },
  } as unknown as ExtensionAPI;

  const tool = definePwshTool(fakePi);
  const multiLineCmd = "Get-Process |\n  Select-Object -First 1";
  const res = await tool.execute(
    "call_multiline_delivery",
    {
      command: multiLineCmd,
      async: true,
      i: "   ", // whitespace only should fallback to command
    },
    undefined,
    undefined,
  );

  expect(res.details.command).toBe(multiLineCmd);
  const jobId = res.details?.jobId ?? "";
  const job = getJobManager().getJob(jobId);
  await job?.settled;

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
