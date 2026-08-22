import { expect, test } from "bun:test";
import { definePwshTool, getHighlighterInstance, highlightPowerShell, runPwsh } from "./pwsh-tool";
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
		expect(firstOutput!.elapsedMs).toBeLessThan(1000);
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

test("highlightPowerShell correctly applies theme colors to PowerShell syntax tokens", async () => {
	await getHighlighterInstance();
	const captured: Array<{ color: string; text: string }> = [];
	const customTheme = {
		fg: (color: string, text: string) => {
			captured.push({ color, text });
			return `[${color}]${text}[/${color}]`;
		},
	};

	const code = `$items = 1..10 | Where-Object { $_ -gt 5 } # filter items`;
	const lines = highlightPowerShell(code, customTheme);

	expect(lines.length).toBe(1);
	expect(captured.some(c => c.color === "syntaxVariable" && c.text.includes("$items"))).toBe(true);
	expect(captured.some(c => c.color === "syntaxFunction" && c.text.includes("Where-Object"))).toBe(true);
	expect(captured.some(c => c.color === "syntaxOperator" && c.text.includes("-gt"))).toBe(true);
	expect(captured.some(c => c.color === "syntaxNumber" && c.text === "5")).toBe(true);
	expect(captured.some(c => c.color === "syntaxComment" && c.text.includes("# filter items"))).toBe(true);
});

test("highlightPowerShell preserves line structure across multiline strings and comments", async () => {
	await getHighlighterInstance();
	const customTheme = {
		fg: (color: string, text: string) => `[${color}:${text}]`,
	};

	const multilineCode = `<#\nBlock comment line 1\nBlock comment line 2\n#>\n$msg = "Multi\nline"\nGet-Date`;
	const lines = highlightPowerShell(multilineCode, customTheme);

	expect(lines.length).toBe(7);
	expect(lines[0]).toContain("[syntaxComment:<#]");
	expect(lines[1]).toContain("[syntaxComment:Block comment line 1]");
	expect(lines[2]).toContain("[syntaxComment:Block comment line 2]");
	expect(lines[3]).toContain("[syntaxComment:#>]");
	expect(lines[4]).toContain("[syntaxVariable:$msg]");
	expect(lines[4]).toContain("[syntaxString:\"Multi]");
	expect(lines[5]).toContain("[syntaxString:line\"]");
	expect(lines[6]).toContain("[syntaxFunction:Get-Date]");
});

test("highlightPowerShell properly handles symbols in code without HTML escaping artifacts", async () => {
	await getHighlighterInstance();
	const customTheme = {
		fg: (_color: string, text: string) => text,
	};

	const codeWithEntities = `if ($a -lt 10 -and $b -gt 20) { Write-Output "A & B: 'test' & \"quotes\"" }`;
	const lines = highlightPowerShell(codeWithEntities, customTheme);

	expect(lines.length).toBe(1);
	expect(lines[0]).toContain(`if ($a -lt 10 -and $b -gt 20) { Write-Output "A & B: 'test' & \"quotes\"" }`);
});

test("highlightPowerShell correctly tokenizes git branch commands", async () => {
	await getHighlighterInstance();
	const captured: Array<{ color: string; text: string }> = [];
	const customTheme = {
		fg: (color: string, text: string) => {
			captured.push({ color, text });
			return `[${color}:${text}]`;
		},
	};

	const code = `git checkout -b feat/issue-175-id-verification`;
	const lines = highlightPowerShell(code, customTheme);

	expect(lines.length).toBe(1);
	// Shiki / TextMate treats unquoted words as plain text and operators as syntaxOperator
	expect(lines[0]).toContain("git checkout");
	expect(lines[0]).toContain("verification");
});
test("registers the tool after cold-start highlighter initialization", async () => {
	const indexUrl = new URL("./index.ts", import.meta.url).href;
	const toolUrl = new URL("./pwsh-tool.ts", import.meta.url).href;
	const childSource = `
import registerPwsh from ${JSON.stringify(indexUrl)};
import { highlightPowerShell } from ${JSON.stringify(toolUrl)};

const schema = () => ({
	describe() { return this; },
	optional() { return this; },
});
const zod = { string: schema, number: schema, enum: schema, object: schema };
const theme = { fg: (color, text) => \`[\${color}]\${text}[/\${color}]\` };
let rendered = "";

await registerPwsh({
	setLabel() {},
	zod,
	registerTool() {
		rendered = highlightPowerShell("$value = 1", theme).join("\\n");
	},
});
console.log(JSON.stringify(rendered));
`;
	const proc = Bun.spawn(["bun", "-e", childSource], {
		cwd: import.meta.dir,
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const output = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;

	expect(exitCode).toBe(0);
	expect(JSON.parse(output.trim())).toContain("[syntaxVariable]");
});
