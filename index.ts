/**
 * omp-pwsh7 — 持久 PowerShell 7 会话工具。
 *
 * 与 bash 工具同等的执行体验：一次启动、状态（变量/模块/cwd）跨调用保持。
 * 实现：持久 `pwsh -File runner.ps1` 子进程 + 行协议（base64 JSON）。
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { definePwshTool } from "./pwsh-tool";

export default function (pi: ExtensionAPI): void {
	pi.setLabel("PowerShell 7");
	pi.registerTool(definePwshTool(pi));
}
