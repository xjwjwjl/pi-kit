import { RemoteTransportError } from "../runtime/errors.js";
import type { RemoteAdapter, RemoteExecInput, RemoteExecResult } from "./types.js";

export class HttpProxyAdapter implements RemoteAdapter {
	private readonly baseUrl: string;
	private readonly token: string;

	constructor(host: string, port: number, token: string) {
		this.baseUrl = `http://${host}:${port}`;
		this.token = token;
	}

	async execute(input: RemoteExecInput): Promise<RemoteExecResult> {
		const controller = new AbortController();
		const signal = input.signal
			? AbortSignal.any([input.signal, controller.signal])
			: controller.signal;
		const timer = setTimeout(() => controller.abort(), input.timeoutSeconds * 1000);

		try {
			input.onOutput?.();
			const resp = await fetch(`${this.baseUrl}/exec`, {
				method: "POST",
				headers: {
					"Authorization": `Bearer ${this.token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					program: input.command.executionPath,
					args: input.command.args,
					cwd: input.cwd,
					timeout: input.timeoutSeconds,
				}),
				signal,
			});

			if (!resp.ok) {
				const text = await resp.text().catch(() => "");
				throw new RemoteTransportError(
					`Proxy returned ${resp.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
				);
			}

			const data = (await resp.json()) as {
				exitCode: number;
				stdout: string;
				stderr: string;
				timedOut: boolean;
			};
			const timedOut = data.timedOut || controller.signal.aborted;
			return {
				exitCode: data.exitCode,
				output: `${data.stdout}${data.stderr ? `\n${data.stderr}` : ""}`,
				timedOut,
				cancelled: !timedOut && Boolean(input.signal?.aborted),
			};
		} catch (error: unknown) {
			if (signal.aborted) {
				const timedOut = controller.signal.aborted;
				return {
					exitCode: null,
					output: timedOut ? "Command timed out" : "Command cancelled",
					timedOut,
					cancelled: !timedOut,
				};
			}
			throw new RemoteTransportError(
				`Proxy connection failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			clearTimeout(timer);
		}
	}
}
