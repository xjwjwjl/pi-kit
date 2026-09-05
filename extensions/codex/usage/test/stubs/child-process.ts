import { appendFileSync, readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import nativeChildProcess from "node:child_process?native";
import * as nativeExports from "node:child_process?native";
import { PassThrough, Writable } from "node:stream";

export * from "node:child_process?native";
export { nativeChildProcess as default };

type FakeChild = EventEmitter & {
	stdin: Writable;
	stdout: PassThrough;
	stderr: PassThrough;
	kill: () => boolean;
};

export function spawn(_command: string, _args: string[], _options: unknown): FakeChild {
	const child = new EventEmitter() as FakeChild;
	child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();

	const counterPath = process.env.CODEX_USAGE_COUNTER;
	const delayMs = Number(process.env.CODEX_USAGE_FAKE_CURL_DELAY_MS ?? "250");
	const mode = process.env.CODEX_USAGE_FAKE_CURL_MODE ?? "failure";
	const priorRequests = counterPath
		? (() => {
			try { return readFileSync(counterPath, "utf-8").trim().split("\n").filter(Boolean).length; }
			catch { return 0; }
		})()
		: 0;
	const succeeds = mode === "success" || mode === "success-always" || (mode === "fail-once" && priorRequests > 0);
	if (counterPath) appendFileSync(counterPath, "request\n", "utf-8");
	let closed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const finish = (code: number) => {
		if (closed) return;
		closed = true;
		if (timer) clearTimeout(timer);
		timer = undefined;
		child.stdout.end();
		child.stderr.end();
		child.emit("close", code);
	};
	child.kill = () => {
		if (closed) return false;
		finish(-1);
		return true;
	};
	timer = setTimeout(() => {
		if (!succeeds) {
			finish(22);
			return;
		}
		const response = process.env.CODEX_USAGE_FAKE_RESPONSE ?? JSON.stringify({
			email: "user@example.com",
			plan_type: "pro",
			allowed: true,
			rate_limit: {
				allowed: true,
				primary_window: { used_percent: 24, limit_window_seconds: 18_000, reset_after_seconds: 18_000 },
				secondary_window: { used_percent: 12, limit_window_seconds: 604_800, reset_after_seconds: 604_800 },
			},
		});
		child.stdout.write(response);
		setImmediate(() => finish(0));
	}, delayMs);
	return child;
}

void nativeExports;
