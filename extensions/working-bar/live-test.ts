/**
 * Working Area Live Update Test
 *
 * 测试 setWorkingIndicator / setWorkingMessage 在流式期间能否实时刷新。
 *
 * 用法:
 *   pi --extension D:/code/my-pi/extensions/working-bar/live-test.ts
 *
 * 命令:
 *   /live-test indicator   测试 setWorkingIndicator 实时更新
 *   /live-test message     测试 setWorkingMessage 实时更新
 *   /live-test both        同时测试两个
 *   /live-test off         关闭测试
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type TestMode = "off" | "indicator" | "message" | "both";

function formatElapsed(ms: number): string {
	const sec = Math.floor(ms / 1000);
	const min = Math.floor(sec / 60);
	const s = sec % 60;
	return `${String(min).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export default function (pi: ExtensionAPI) {
	let mode: TestMode = "off";
	let timer: ReturnType<typeof setInterval> | null = null;
	let agentStartTime = 0;

	function stopTimer() {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	}

	function startTimer() {
		stopTimer();
		agentStartTime = Date.now();

		timer = setInterval(() => {
			const elapsed = formatElapsed(Date.now() - agentStartTime);
			const spinnerIdx = Math.floor((Date.now() - agentStartTime) / 80) % SPINNER_FRAMES.length;
			const spinner = SPINNER_FRAMES[spinnerIdx]!;

			if (mode === "indicator" || mode === "both") {
				// 每次 setInterval 都重新设置整个 indicator，模拟动态帧
				// 关键测试: loader 显示期间这个调用能不能实时切换帧
				pi.ctx?.ui.setWorkingIndicator({
					frames: [`${spinner} ⏱ ${elapsed}`],
				});
			}

			if (mode === "message" || mode === "both") {
				// 关键测试: loader 显示期间 setWorkingMessage 能不能实时刷新文字
				pi.ctx?.ui.setWorkingMessage(`⏱ 已耗时 ${elapsed} — Working...`);
			}
		}, 200); // 200ms 刷新一次，方便观察
	}

	pi.on("agent_start", async (_event, ctx) => {
		if (mode === "off") return;

		// 先设一个基础样式
		ctx.ui.setWorkingIndicator({ frames: ["⏱ 00:00"] });
		ctx.ui.setWorkingMessage("⏱ 已耗时 00:00 — Working...");
		ctx.ui.setStatus("live-test", "live-test: timer started");

		startTimer();
	});

	pi.on("agent_end", async (_event, ctx) => {
		stopTimer();
		if (mode !== "off") {
			ctx.ui.setStatus("live-test", `live-test: agent finished, mode=${mode}`);
		}
	});

	pi.on("session_shutdown", async () => {
		stopTimer();
	});

	pi.registerCommand("live-test", {
		description: "Test live update of working indicator/message: indicator, message, both, off",
		handler: async (args, ctx) => {
			const next = args.trim().toLowerCase();
			if (!next || !["off", "indicator", "message", "both"].includes(next)) {
				ctx.ui.notify(
					"Usage: /live-test [indicator|message|both|off]  当前模式: " + mode,
					"info",
				);
				return;
			}

			stopTimer();
			mode = next as TestMode;

			if (mode === "off") {
				ctx.ui.setWorkingIndicator();
				ctx.ui.setWorkingMessage();
				ctx.ui.setStatus("live-test", undefined);
				ctx.ui.notify("Live test OFF — 已恢复默认", "info");
			} else {
				ctx.ui.setStatus("live-test", `live-test: ${mode} mode (发送消息触发)`);
				ctx.ui.notify(
					`Live test: ${mode} mode — 发送一条消息即可看到效果`,
					"info",
				);
			}
		},
	});
}
