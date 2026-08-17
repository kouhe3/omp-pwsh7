import { expect, test } from "bun:test";
import { definePwshTool } from "./pwsh-tool";

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
