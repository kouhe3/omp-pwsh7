import { expect, test } from "bun:test";
import { definePwshTool, runPwsh } from "./pwsh-tool";
import { PwshSessionPool } from "./session";

const schema = () => ({
	describe() {
		return this;
	},
	optional() {
		return this;
	},
});

const zStub = {
	string: schema,
	number: schema,
	enum: schema,
	object: schema,
};

const theme = {
	fg: (_color: string, text: string) => `\x1b[38;5;244m${text}\x1b[0m`,
	boxRound: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
	boxSharp: { teeLeft: "┤", teeRight: "├", horizontal: "─" },
};

function renderCommand(command: string, width: number): string[] {
	const tool = definePwshTool({ zod: zStub } as never);
	return tool.renderCall({ command }, {}, theme).render(width);
}

test("renders the complete long command instead of replacing its tail with an ellipsis", () => {
	const command = `Write-Output ${"x".repeat(150)}`;
	const rows = renderCommand(command, 80);
	const commandRows = rows
		.slice(1, -1)
		.map(row => row.replace(/\x1b\[[0-9;]*m/g, "").slice(2, -2).trimEnd());

	expect(rows.join("\n")).not.toContain("…");
	expect(commandRows.join("")).toBe(command);
});

test("keeps the complete reported command tail visible after wrapping", () => {
	const command = "$items = 1..8 | ForEach-Object { Start-Sleep -Milliseconds 500; [pscustomobject]@{Step = $_; Timestamp = Get-Date -Format 'HH:mm:ss.fff'} }; $items | Format-Table -AutoSize | Out-String";
	const tool = definePwshTool({ zod: zStub } as never);
	const rendered = tool
		.renderResult(
			{
				details: {
					cwd: ".",
					sessionKey: ".",
					format: "text",
					timeoutSec: 30,
					exitCode: 0,
					output: "ok",
					wallTimeMs: 1,
				},
			},
			{},
			theme,
			{ command },
		)
		.render(80)
		.join("\n");

	expect(rendered).not.toContain("…");
	expect(rendered).toContain("Out-String");
});

test("uses normal optional property names in the public tool schema", () => {
	const objectShapes: Array<Record<string, unknown>> = [];
	const node = () => ({
		optional() {
			return this;
		},
		describe() {
			return this;
		},
	});
	const z = {
		string: node,
		number: node,
		enum: node,
		object(shape: Record<string, unknown>) {
			objectShapes.push(shape);
			return node();
		},
	};

	definePwshTool({ zod: z } as never);
	expect(Object.keys(objectShapes.at(-1)!)).toEqual(["command", "cwd", "env", "format", "width", "timeout", "session"]);
});

test("preserves deeply nested objects in JSON format", async () => {
	const pool = new PwshSessionPool({ runnerPath: `${import.meta.dir}/runner.ps1` });
	try {
		const session = pool.getOrCreate(`json-depth-${Date.now()}`, process.cwd());
		const result = await session.run(
			{
				code: "$v = [pscustomobject]@{ Value = 'preserve-me' }; 1..12 | ForEach-Object { $v = [pscustomobject]@{ Level = $_; Child = $v } }; [pscustomobject]@{ Name = 'root'; Icons = $v }",
				format: "json",
			},
			{ timeoutMs: 30_000 },
		);
		expect(result.response?.error ?? null).toBeNull();
		const value = JSON.parse(result.response?.output ?? "null") as { Name: string; Icons: { Child: { Child: unknown } } };
		expect(value.Name).toBe("root");
		expect(value.Icons.Child.Child).not.toBe("@{Level=4; Child=}");
		expect(JSON.stringify(value)).toContain("preserve-me");
	} finally {
		pool.disposeAll();
	}
});

test("streams text output before the command completes", async () => {
	const pool = new PwshSessionPool({ runnerPath: `${import.meta.dir}/runner.ps1` });
	try {
		const updates: Array<{ text: string; elapsedMs: number }> = [];
		const started = Date.now();
		const result = await runPwsh(
			{
				command: "Write-Output 'first'; Start-Sleep -Milliseconds 600; Write-Output 'second'",
				cwd: process.cwd(),
				timeout: 10,
			},
			pool,
			update => updates.push({ text: update.content[0]?.text ?? "", elapsedMs: Date.now() - started }),
		);

		const firstOutput = updates.find(update => update.text.includes("first"));
		expect(firstOutput).toBeDefined();
		expect(firstOutput!.elapsedMs).toBeLessThan(550);
		expect(updates.at(-1)?.text).toContain("second");
		expect(result.text).toContain("first");
		expect(result.text).toContain("second");
	} finally {
		pool.disposeAll();
	}
});

test("keeps JSON output as one final document without streaming fragments", async () => {
	const pool = new PwshSessionPool({ runnerPath: `${import.meta.dir}/runner.ps1` });
	try {
		const updates: string[] = [];
		const result = await runPwsh(
			{ command: "1..2 | ForEach-Object { [pscustomobject]@{ Value = $_ } }", cwd: process.cwd(), format: "json" },
			pool,
			update => updates.push(update.content[0]?.text ?? ""),
		);

		expect(updates.some(update => update.includes("Value"))).toBe(false);
		expect(JSON.parse(result.details.output ?? "null")).toEqual([{ Value: 1 }, { Value: 2 }]);
	} finally {
		pool.disposeAll();
	}
});

test("preserves session state after a streamed command", async () => {
	const pool = new PwshSessionPool({ runnerPath: `${import.meta.dir}/runner.ps1` });
	try {
		const session = pool.getOrCreate(`stream-state-${Date.now()}`, process.cwd());
		await session.run({ code: "$streamState = 42; Write-Output 'ready'", format: "text" }, { timeoutMs: 10_000 });
		const result = await session.run({ code: "$streamState", format: "text" }, { timeoutMs: 10_000 });

		expect(result.response?.output?.trim()).toBe("42");
	} finally {
		pool.disposeAll();
	}
});

test("returns streamed output when a command times out", async () => {
	const pool = new PwshSessionPool({ runnerPath: `${import.meta.dir}/runner.ps1` });
	try {
		const session = pool.getOrCreate(`stream-timeout-${Date.now()}`, process.cwd());
		const result = await session.run(
			{ code: "Write-Output 'before-timeout'; Start-Sleep -Seconds 3", format: "text" },
			{ timeoutMs: 700 },
		);

		expect(result.timedOut).toBe(true);
		expect(result.partialOutput).toContain("before-timeout");
	} finally {
		pool.disposeAll();
	}
});

test("wraps long output without replacing its tail with an ellipsis", () => {
	const output = JSON.stringify({ Name: "root", Icons: { Value: "preserve-me", Padding: "x".repeat(180) } });
	const tool = definePwshTool({ zod: zStub } as never);
	const rows = tool
		.renderResult(
			{
				details: {
					cwd: ".",
					sessionKey: ".",
					format: "json",
					timeoutSec: 30,
					exitCode: 0,
					output,
					wallTimeMs: 1,
				},
			},
			{},
			theme,
			{ command: "Get-Value" },
		)
		.render(80);
	const dividerIndex = rows.findIndex(row => row.includes("completed"));
	const outputRows = rows
		.slice(dividerIndex + 1, -1)
		.map(row => row.replace(/\x1b\[[0-9;]*m/g, "").slice(2, -2).trimEnd());

	expect(rows.join("\n")).not.toContain("…");
	expect(outputRows.join("")).toBe(output);
});
