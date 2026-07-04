import {
	formatAnalyze,
	formatDatabases,
	formatDescribe,
	formatExplain,
	formatPing,
	formatProfileQuery,
	formatQuery,
	formatSearchTables,
	formatSources,
	formatTables,
	formatUpsertSource,
	formatValidateConfig,
	formatWrite,
} from "./formatters.js";
import { isRecord } from "../utils.js";

type RenderComponent = {
	render(width: number): string[];
	invalidate(): void;
};

type RenderOptions = {
	expanded?: boolean;
	isPartial?: boolean;
};

export type RenderContext = {
	isError?: boolean;
};

type ThemeLike = {
	fg?: (color: string, text: string) => string;
	bold?: (text: string) => string;
};

const ANSI_PATTERN = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/y;

function isTheme(value: unknown): value is ThemeLike {
	return isRecord(value) && (typeof value.fg === "function" || typeof value.bold === "function");
}

function fg(theme: unknown, color: string, text: string): string {
	return isTheme(theme) && typeof theme.fg === "function" ? theme.fg(color, text) : text;
}

function bold(theme: unknown, text: string): string {
	return isTheme(theme) && typeof theme.bold === "function" ? theme.bold(text) : text;
}

function tool(theme: unknown, name: string): string {
	return fg(theme, "toolTitle", bold(theme, name));
}

function accent(theme: unknown, text: string): string {
	return fg(theme, "accent", text);
}

function muted(theme: unknown, text: string): string {
	return fg(theme, "muted", text);
}

function dim(theme: unknown, text: string): string {
	return fg(theme, "dim", text);
}

function success(theme: unknown, text: string): string {
	return fg(theme, "success", text);
}

function warning(theme: unknown, text: string): string {
	return fg(theme, "warning", text);
}

function error(theme: unknown, text: string): string {
	return fg(theme, "error", text);
}

function truncateLine(text: string, width: number): string {
	if (width <= 0) return "";
	let visible = 0;
	let output = "";
	for (let index = 0; index < text.length;) {
		ANSI_PATTERN.lastIndex = index;
		const ansi = ANSI_PATTERN.exec(text);
		if (ansi && ansi.index === index) {
			output += ansi[0];
			index += ansi[0].length;
			continue;
		}
		const char = text[index] ?? "";
		if (visible >= width) return `${output.slice(0)}…`;
		if (visible === width - 1 && index < text.length - 1) return `${output}…`;
		output += char;
		visible++;
		index++;
	}
	return output;
}

function linesComponent(getLines: (width: number) => string[]): RenderComponent {
	return {
		render(width: number) {
			return getLines(width).map((line) => truncateLine(line, width));
		},
		invalidate() {},
	};
}

function normalizeQueryPreview(value: unknown, maxChars = 90): string {
	if (typeof value !== "string") return "";
	const compact = value.replace(/\s+/g, " ").trim();
	if (compact.length <= maxChars) return compact;
	return `${compact.slice(0, maxChars - 1)}…`;
}

function expandedTextLines(text: string, width: number, theme: unknown, maxLines = 40): string[] {
	const lines = text.split(/\r?\n/);
	const limited = lines.slice(0, maxLines).map((line) => dim(theme, truncateLine(line, width)));
	if (lines.length > maxLines) {
		limited.push(dim(theme, `... ${lines.length - maxLines} more line(s)`));
	}
	return limited;
}

function detailLines(summary: string, expanded: boolean, expandedText: string | undefined, theme: unknown): (width: number) => string[] {
	return (width: number) => {
		const lines = [summary];
		if (expanded && expandedText) {
			lines.push(dim(theme, "─".repeat(Math.min(width, 24))));
			lines.push(...expandedTextLines(expandedText, width, theme));
		}
		return lines;
	};
}

function callLine(theme: unknown, name: string, bits: Array<string | undefined>, preview?: string): string {
	const suffix = bits.filter(Boolean).map((bit) => muted(theme, bit as string)).join(" ");
	const base = `${tool(theme, name)}${suffix ? ` ${suffix}` : ""}`;
	return preview ? `${base} ${dim(theme, "•")} ${accent(theme, preview)}` : base;
}

function metric(theme: unknown, label: string, value: unknown): string {
	return `${dim(theme, `${label} `)}${accent(theme, String(value))}`;
}

function status(theme: unknown, value: "ok" | "warn" | "error" | "running", text: string): string {
	if (value === "ok") return success(theme, `✓ ${text}`);
	if (value === "warn") return warning(theme, `! ${text}`);
	if (value === "error") return error(theme, `✗ ${text}`);
	return warning(theme, `… ${text}`);
}

function field(args: unknown, key: string): unknown {
	return isRecord(args) ? args[key] : undefined;
}

function contentText(result: { content?: unknown }): string | undefined {
	const content = Array.isArray(result.content) ? result.content[0] : undefined;
	return isRecord(content) && typeof content.text === "string" ? content.text : undefined;
}

function isSqlkitQueryBlock(result: { content?: unknown }): boolean {
	return /^\[SQLKIT (?:QUERY|APPLY|WRITE) (?:BLOCKED|FAILED)/.test(contentText(result) ?? "");
}

function errorSummary(theme: unknown, result: { content?: unknown }, fallback: string): RenderComponent {
	const text = contentText(result) ?? fallback;
	const firstLine = text.split(/\r?\n/).find((line) => line.trim()) ?? fallback;
	return linesComponent(detailLines(status(theme, "error", firstLine), true, text, theme));
}

export const listSourcesRender = {
	call(args: unknown, theme?: unknown, _context?: unknown) {
		const source = field(args, "source");
		return linesComponent(() => [callLine(theme, "sql_list_sources", source ? [`source=${String(source)}`] : [])]);
	},
	result(result: { details?: unknown; content?: unknown }, options: RenderOptions, theme?: unknown, _context?: unknown) {
		const details = result.details as { sources?: Array<{ name?: string; dialect?: string }> } | undefined;
		const count = Array.isArray(details?.sources) ? details.sources.length : 0;
		const summary = `${status(theme, "ok", "sources")} ${metric(theme, "count", count)}`;
		const expanded = details ? formatSources(details as never) : contentText(result);
		return linesComponent(detailLines(summary, options.expanded === true, expanded, theme));
	},
};

export const validateConfigRender = {
	call(args: unknown, theme?: unknown, _context?: unknown) {
		const checkConnections = field(args, "check_connections") === true;
		return linesComponent(() => [callLine(theme, "sql_validate_config", checkConnections ? ["check_connections=true"] : [])]);
	},
	result(result: { details?: unknown; content?: unknown }, options: RenderOptions, theme?: unknown, _context?: unknown) {
		const details = result.details as { ok?: boolean; issues?: unknown[]; sources?: unknown[] } | undefined;
		const issues = Array.isArray(details?.issues) ? details.issues.length : 0;
		const sources = Array.isArray(details?.sources) ? details.sources.length : 0;
		const summary = `${status(theme, details?.ok === false ? "warn" : "ok", details?.ok === false ? "config issues" : "config ok")} ${metric(theme, "sources", sources)} ${metric(theme, "issues", issues)}`;
		const expanded = details ? formatValidateConfig(details as never) : contentText(result);
		return linesComponent(detailLines(summary, options.expanded === true, expanded, theme));
	},
};

export const upsertSourceRender = {
	call(args: unknown, theme?: unknown, _context?: unknown) {
		const name = field(args, "name");
		const dialect = field(args, "dialect");
		const bits = [name ? String(name) : undefined, dialect ? String(dialect) : undefined];
		return linesComponent(() => [callLine(theme, "sql_upsert_source", bits)]);
	},
	result(result: { details?: unknown; content?: unknown }, options: RenderOptions, theme?: unknown, _context?: unknown) {
		const details = result.details as { source?: string; dialect?: string; created?: boolean; sources_count?: number } | undefined;
		const label = details?.created ? "source created" : "source updated";
		const summary = `${status(theme, "ok", label)} ${details?.source ? metric(theme, "name", details.source) : ""} ${details?.dialect ? metric(theme, "dialect", details.dialect) : ""} ${metric(theme, "sources", details?.sources_count ?? 0)}`.trim();
		const expanded = details ? formatUpsertSource(details as never) : contentText(result);
		return linesComponent(detailLines(summary, options.expanded === true, expanded, theme));
	},
};

export const pingRender = {
	call(args: unknown, theme?: unknown, _context?: unknown) {
		const source = field(args, "source");
		return linesComponent(() => [callLine(theme, "sql_ping", source ? [String(source)] : [])]);
	},
	result(result: { details?: unknown; content?: unknown }, options: RenderOptions, theme?: unknown, _context?: unknown) {
		const details = result.details as { source?: string; ok?: boolean; current_database?: string } | undefined;
		const summary = `${status(theme, details?.ok === false ? "error" : "ok", details?.source ?? "source")} ${details?.current_database ? metric(theme, "db", details.current_database) : ""}`.trim();
		const expanded = details ? formatPing(details as never) : contentText(result);
		return linesComponent(detailLines(summary, options.expanded === true, expanded, theme));
	},
};

export const listDatabasesRender = {
	call(args: unknown, theme?: unknown, _context?: unknown) {
		const source = field(args, "source");
		return linesComponent(() => [callLine(theme, "sql_list_databases", source ? [String(source)] : [])]);
	},
	result(result: { details?: unknown; content?: unknown }, options: RenderOptions, theme?: unknown, _context?: unknown) {
		const details = result.details as { source?: string; databases?: string[] } | undefined;
		const count = Array.isArray(details?.databases) ? details.databases.length : 0;
		const summary = `${status(theme, "ok", details?.source ?? "databases")} ${metric(theme, "databases", count)}`;
		const expanded = details ? formatDatabases(details as never) : contentText(result);
		return linesComponent(detailLines(summary, options.expanded === true, expanded, theme));
	},
};

export const listTablesRender = {
	call(args: unknown, theme?: unknown, _context?: unknown) {
		const database = field(args, "database");
		const like = field(args, "like");
		const maxResults = field(args, "max_results");
		const bits = [database ? `db=${String(database)}` : undefined, like ? `like=${String(like)}` : undefined, maxResults != null ? `max=${String(maxResults)}` : undefined];
		return linesComponent(() => [callLine(theme, "sql_list_tables", bits)]);
	},
	result(result: { details?: unknown; content?: unknown }, options: RenderOptions, theme?: unknown, _context?: unknown) {
		const details = result.details as { database?: string; count?: number; total_count?: number; truncated?: boolean; engine_groups?: unknown[] } | undefined;
		const count = typeof details?.count === "number" ? details.count : 0;
		const total = typeof details?.total_count === "number" ? details.total_count : undefined;
		const groups = Array.isArray(details?.engine_groups) && details.engine_groups.length > 0 ? ` ${metric(theme, "engines", details.engine_groups.length)}` : "";
		const summary = `${status(theme, details?.truncated ? "warn" : "ok", details?.database ?? "tables")} ${metric(theme, "tables", total != null ? `${count}/${total}` : count)}${groups}${details?.truncated ? ` ${warning(theme, "truncated")}` : ""}`;
		const expanded = details ? formatTables(details as never) : contentText(result);
		return linesComponent(detailLines(summary, options.expanded === true, expanded, theme));
	},
};

export const searchTablesRender = {
	call(args: unknown, theme?: unknown, _context?: unknown) {
		const database = field(args, "database");
		const keyword = field(args, "keyword");
		const column = field(args, "column");
		const bits = [database ? `db=${String(database)}` : undefined, keyword ? `keyword=${String(keyword)}` : undefined, column ? `column=${String(column)}` : undefined];
		return linesComponent(() => [callLine(theme, "sql_search_tables", bits)]);
	},
	result(result: { details?: unknown; content?: unknown }, options: RenderOptions, theme?: unknown, _context?: unknown) {
		const details = result.details as { count?: number; truncated?: boolean } | undefined;
		const count = typeof details?.count === "number" ? details.count : 0;
		const summary = `${status(theme, details?.truncated ? "warn" : "ok", "matches")} ${metric(theme, "count", count)}${details?.truncated ? ` ${warning(theme, "truncated")}` : ""}`;
		const expanded = details ? formatSearchTables(details as never) : contentText(result);
		return linesComponent(detailLines(summary, options.expanded === true, expanded, theme));
	},
};

export const describeTableRender = {
	call(args: unknown, theme?: unknown, _context?: unknown) {
		const database = field(args, "database");
		const table = field(args, "table");
		const ref = `${database ? `${String(database)}.` : ""}${table ? String(table) : "<table>"}`;
		return linesComponent(() => [callLine(theme, "sql_describe_table", [ref])]);
	},
	result(result: { details?: unknown; content?: unknown }, options: RenderOptions, theme?: unknown, _context?: unknown) {
		const details = result.details as { database?: string; table?: string; columns?: unknown[]; engine?: string } | undefined;
		const count = Array.isArray(details?.columns) ? details.columns.length : 0;
		const ref = `${details?.database ?? "<db>"}.${details?.table ?? "<table>"}`;
		const summary = `${status(theme, "ok", ref)} ${metric(theme, "columns", count)}${details?.engine ? ` ${metric(theme, "engine", details.engine)}` : ""}`;
		const expanded = details ? formatDescribe(details as never) : contentText(result);
		return linesComponent(detailLines(summary, options.expanded === true, expanded, theme));
	},
};

export const runQueryRender = {
	call(args: unknown, theme?: unknown, _context?: unknown) {
		const source = field(args, "source");
		const query = normalizeQueryPreview(field(args, "query"));
		return linesComponent(() => [callLine(theme, "sql_run_query", source ? [String(source)] : [], query)]);
	},
	result(result: { details?: unknown; content?: unknown }, options: RenderOptions, theme?: unknown, context?: RenderContext) {
		if (context?.isError || isSqlkitQueryBlock(result)) return errorSummary(theme, result, "sql_run_query failed");
		const details = result.details as { query_kind?: string; row_count?: number; duration_ms?: number; truncated?: boolean } | undefined;
		const summary = `${status(theme, details?.truncated ? "warn" : "ok", details?.query_kind ?? "query")} ${metric(theme, "rows", details?.row_count ?? 0)} ${metric(theme, "time", `${details?.duration_ms ?? 0}ms`)}${details?.truncated ? ` ${warning(theme, "truncated")}` : ""}`;
		const expanded = details ? formatQuery(details as never) : contentText(result);
		return linesComponent(detailLines(summary, options.expanded === true, expanded, theme));
	},
};

export const profileQueryRender = {
	call(args: unknown, theme?: unknown, _context?: unknown) {
		const source = field(args, "source");
		const query = normalizeQueryPreview(field(args, "query"));
		return linesComponent(() => [callLine(theme, "sql_clickhouse_profile_query", source ? [String(source)] : [], query)]);
	},
	result(result: { details?: unknown; content?: unknown }, options: RenderOptions, theme?: unknown, context?: RenderContext) {
		if (context?.isError || isSqlkitQueryBlock(result)) return errorSummary(theme, result, "sql_clickhouse_profile_query failed");
		const details = result.details as { query_kind?: string; row_count?: number; duration_ms?: number; truncated?: boolean; runtime_profile?: { status?: string } } | undefined;
		const profileStatus = details?.runtime_profile?.status === "available" ? "profile=ok" : "profile=unavailable";
		const summary = `${status(theme, details?.truncated ? "warn" : "ok", details?.query_kind ?? "query")} ${metric(theme, "rows", details?.row_count ?? 0)} ${metric(theme, "time", `${details?.duration_ms ?? 0}ms`)} ${muted(theme, profileStatus)}${details?.truncated ? ` ${warning(theme, "truncated")}` : ""}`;
		const expanded = details ? formatProfileQuery(details as never) : contentText(result);
		return linesComponent(detailLines(summary, options.expanded === true, expanded, theme));
	},
};

export const explainQueryRender = {
	call(args: unknown, theme?: unknown, _context?: unknown) {
		const source = field(args, "source");
		const mode = field(args, "mode");
		const query = normalizeQueryPreview(field(args, "query"));
		const bits = [source ? String(source) : undefined, mode ? `mode=${String(mode)}` : undefined];
		return linesComponent(() => [callLine(theme, "sql_explain_query", bits, query)]);
	},
	result(result: { details?: unknown; content?: unknown }, options: RenderOptions, theme?: unknown, context?: RenderContext) {
		if (context?.isError || isSqlkitQueryBlock(result)) return errorSummary(theme, result, "sql_explain_query failed");
		const details = result.details as { explain_mode?: string; row_count?: number; duration_ms?: number; truncated?: boolean } | undefined;
		const summary = `${status(theme, details?.truncated ? "warn" : "ok", details?.explain_mode ?? "plan")} ${metric(theme, "rows", details?.row_count ?? 0)} ${metric(theme, "time", `${details?.duration_ms ?? 0}ms`)}${details?.truncated ? ` ${warning(theme, "truncated")}` : ""}`;
		const expanded = details ? formatExplain(details as never) : contentText(result);
		return linesComponent(detailLines(summary, options.expanded === true, expanded, theme));
	},
};

export const analyzeQueryRender = {
	call(args: unknown, theme?: unknown, _context?: unknown) {
		const source = field(args, "source");
		const mode = field(args, "mode");
		const query = normalizeQueryPreview(field(args, "query"));
		const bits = [source ? String(source) : undefined, mode ? `mode=${String(mode)}` : undefined];
		return linesComponent(() => [callLine(theme, "sql_mysql_analyze_query", bits, query)]);
	},
	result(result: { details?: unknown; content?: unknown }, options: RenderOptions, theme?: unknown, context?: RenderContext) {
		if (context?.isError || isSqlkitQueryBlock(result)) return errorSummary(theme, result, "sql_mysql_analyze_query failed");
		const details = result.details as { analyze_mode?: string; row_count?: number; duration_ms?: number; truncated?: boolean } | undefined;
		const summary = `${status(theme, details?.truncated ? "warn" : "ok", details?.analyze_mode ?? "analyze")} ${metric(theme, "rows", details?.row_count ?? 0)} ${metric(theme, "time", `${details?.duration_ms ?? 0}ms`)}${details?.truncated ? ` ${warning(theme, "truncated")}` : ""}`;
		const expanded = details ? formatAnalyze(details as never) : contentText(result);
		return linesComponent(detailLines(summary, options.expanded === true, expanded, theme));
	},
};

export const writeRender = {
	call(args: unknown, theme?: unknown, _context?: unknown) {
		const source = field(args, "source");
		const statement = normalizeQueryPreview(field(args, "statement"));
		return linesComponent(() => [callLine(theme, "sql_apply", source ? [String(source)] : [], statement)]);
	},
	result(result: { details?: unknown; content?: unknown }, options: RenderOptions, theme?: unknown, context?: RenderContext) {
		if (context?.isError || isSqlkitQueryBlock(result)) return errorSummary(theme, result, "sql_apply failed");
		const details = result.details as { statement_kind?: string; executed?: boolean; cancelled?: boolean; duration_ms?: number; affected_rows?: number } | undefined;
		const statusKind = details?.executed
			? "ok"
			: details?.cancelled
				? "warn"
				: "warn";
		const label = details?.executed ? details?.statement_kind ?? "write" : details?.cancelled ? "cancelled" : "not executed";
		const rows = details?.affected_rows != null ? ` ${metric(theme, "affected", details.affected_rows)}` : "";
		const summary = `${status(theme, statusKind, label)}${rows} ${metric(theme, "time", `${details?.duration_ms ?? 0}ms`)}`;
		const expanded = details ? formatWrite(details as never) : contentText(result);
		return linesComponent(detailLines(summary, options.expanded === true, expanded, theme));
	},
};
