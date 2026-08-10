import type { VerifiedCommand } from "../policy/shell-parser.js";

export interface RemoteExecInput {
	cwd: string;
	command: VerifiedCommand;
	timeoutSeconds: number;
	signal?: AbortSignal;
	onOutput?: () => void;
}

export interface RemoteExecResult {
	exitCode: number | null;
	output: string;
	timedOut: boolean;
	cancelled: boolean;
}

export interface RemoteAdapter {
	execute(input: RemoteExecInput): Promise<RemoteExecResult>;
}

export interface AdapterFactory {
	create(host: string, port: number, token: string): RemoteAdapter;
}
