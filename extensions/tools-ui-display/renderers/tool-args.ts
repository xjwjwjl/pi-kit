export type ToolPathArgs = {
	path?: string;
	file_path?: string;
};

export type BashArgs = {
	command?: string;
	timeout?: number;
};

export type ReadArgs = ToolPathArgs & {
	offset?: number;
	limit?: number;
};

export type WriteArgs = ToolPathArgs & {
	content?: string;
};

export function resolveToolPath(args: ToolPathArgs): string | undefined {
	return args.file_path ?? args.path;
}

export function resolveBashCommand(args: BashArgs): string {
	return typeof args.command === "string" && args.command.length > 0 ? args.command : "...";
}

function formatSeconds(value: number): string {
	return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

export function resolveBashTimeout(args: BashArgs): string | undefined {
	return typeof args.timeout === "number" && Number.isFinite(args.timeout) && args.timeout > 0
		? `timeout ${formatSeconds(args.timeout)}s`
		: undefined;
}

export function resolveReadRange(args: ReadArgs): { start: number; end?: number } | undefined {
	if (args.offset === undefined && args.limit === undefined) return undefined;
	const start = typeof args.offset === "number" ? args.offset : 1;
	const end = typeof args.limit === "number" ? start + args.limit - 1 : undefined;
	return { start, end };
}
