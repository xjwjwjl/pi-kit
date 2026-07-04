export const TEST_CONNECTION_TIMEOUT_MS = 10_000;
export const TEST_CONNECTION_TIMEOUT_SECONDS = TEST_CONNECTION_TIMEOUT_MS / 1000;

type ConnectionNotice = {
	message: string;
	type: "info" | "warning" | "error";
};

export function formatConnectionFailure(message: string): string {
	if (/timed out|timeout/i.test(message)) {
		return `Connection timed out after ${TEST_CONNECTION_TIMEOUT_SECONDS}s. Check datasource connection settings.`;
	}
	if (/ECONNREFUSED|connection refused/i.test(message)) {
		return "Unable to connect. Check datasource connection settings.";
	}
	if (/access denied|authentication|password|credentials|ER_ACCESS_DENIED_ERROR/i.test(message)) {
		return "Authentication failed. Check user and password.";
	}
	return `Connection failed. ${message}`;
}

export function formatConnectionNotice(result: string): ConnectionNotice {
	if (result.startsWith("Connected:")) {
		return {
			message: `Connection successful · ${result.replace(/^Connected:\s*/, "")}`,
			type: "info",
		};
	}
	return { message: formatConnectionFailure(result), type: "warning" };
}

export function formatTestingStatus(elapsedSeconds: number): string {
	return `Testing connection… ${elapsedSeconds}/${TEST_CONNECTION_TIMEOUT_SECONDS}s`;
}

export function formatSuccessfulConnection(seconds: number, result: string): string {
	return `Connection successful (${seconds}s) · ${result.replace(/^Connected:\s*/, "")}`;
}
