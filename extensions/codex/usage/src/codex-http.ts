import { spawn } from "node:child_process";

export interface CurlJsonOptions {
	method?: "GET" | "POST";
	accessToken: string;
	headers?: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
}

/**
 * Perform a JSON request to the Codex backend through curl.
 *
 * The curl config is passed on stdin so the Bearer token never appears in the
 * process arguments. `--http1.1` and the connect/total timeouts match the
 * original usage implementation; `--fail-with-body` keeps backend validation
 * messages in stdout while stderr still reports the HTTP status.
 */
export function curlJson(url: string, options: CurlJsonOptions): Promise<string> {
	const signal = options.signal;
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(createAbortError());
			return;
		}

		const child = spawn("curl", ["-sS", "--fail-with-body", "--http1.1", "-K", "-"], { windowsHide: true });
		let stdout = "";
		let stderr = "";
		let settled = false;

		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			callback();
		};
		const rejectOnce = (error: unknown) => {
			if (settled) return;
			try {
				child.kill();
			} catch {
				// The process may already have exited.
			}
			finish(() => reject(error instanceof Error ? error : new Error(String(error))));
		};
		const onAbort = () => rejectOnce(createAbortError());

		child.stdout.setEncoding("utf-8");
		child.stderr.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => { stdout += chunk; });
		child.stderr.on("data", (chunk: string) => { stderr += chunk; });
		child.stdin.on("error", rejectOnce);
		child.stdout.on("error", rejectOnce);
		child.stderr.on("error", rejectOnce);
		child.on("error", rejectOnce);
		child.on("close", (code) => {
			if (signal?.aborted) {
				rejectOnce(createAbortError());
			} else if (code === 0) {
				finish(() => resolve(stdout));
			} else {
				rejectOnce(new Error(formatCurlFailure(code, stderr, stdout)));
			}
		});
		signal?.addEventListener("abort", onAbort, { once: true });

		try {
			const config = [
				`url = "${curlEscape(url)}"`,
				`request = "${options.method ?? "GET"}"`,
				`header = "Authorization: Bearer ${curlEscape(options.accessToken)}"`,
				'header = "Accept: application/json"',
				...Object.entries(options.headers ?? {}).map(([name, value]) =>
					`header = "${curlEscape(`${name}: ${value}`)}"`),
				...(options.body === undefined ? [] : [`data-raw = "${curlEscape(options.body)}"`]),
				"connect-timeout = 10",
				"max-time = 20",
				"",
			].join("\n");
			child.stdin.end(config);
		} catch (error) {
			rejectOnce(error);
		}
	});
}

export function createAbortError(): Error {
	const error = new Error("curl request cancelled");
	error.name = "AbortError";
	return error;
}

export function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

export function describeError(error: unknown): string {
	return error instanceof Error && error.message ? error.message : String(error);
}

function curlEscape(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * curl exits non-zero on HTTP errors (`--fail-with-body`) and prints the error to
 * stderr while the response body lands on stdout; surface both so backend
 * validation messages are not lost.
 */
function formatCurlFailure(code: number | null, stderr: string, stdout: string): string {
	const status = stderr.trim() || `curl exit ${code ?? "unknown"}`;
	const body = stdout.trim().replace(/\s+/g, " ");
	if (!body) return status;
	return `${status}; response body: ${body.length > 300 ? `${body.slice(0, 300)}…` : body}`;
}
