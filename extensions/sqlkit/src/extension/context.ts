import { Buffer } from "node:buffer";
import { loadProjectConfig } from "../config/loader.js";
import { SQL_TABULAR_TOOL_NAMES, SQL_TOOL_CONTEXT_SHAPE_BY_NAME, SQL_TOOL_NAMES } from "../core/catalog.js";
import { isRecord } from "../utils.js";

const TOOL_NAMES = new Set(SQL_TOOL_NAMES);
const TABULAR_TOOL_NAMES = new Set(SQL_TABULAR_TOOL_NAMES);

const LLM_FULL_DETAILS_MAX_BYTES = 80_000;
const LLM_ROW_SAMPLE_LIMIT = 20;
const LLM_TABLE_SAMPLE_LIMIT = 100;
const LLM_DATABASE_SAMPLE_LIMIT = 100;
const LLM_DESCRIBE_COLUMN_LIMIT = 80;
const LLM_DESCRIBE_INDEX_LIMIT = 40;
const LLM_DESCRIBE_RELATION_LIMIT = 40;
const LLM_SEARCH_MATCH_LIMIT = 30;
const LLM_MATCHED_COLUMN_LIMIT = 5;
const LLM_CREATE_STATEMENT_CHARS = 12_000;

export function buildStatusText(cwd: string): string {
	try {
		const config = loadProjectConfig(cwd);
		if (config.sources.length === 0) return "sqlkit: no sources";
		if (config.sources.length === 1) return `sqlkit: ${config.sources[0].name}`;
		return `sqlkit: ${config.sources.length} sources`;
	} catch {
		return "sqlkit: no config";
	}
}

function compactJsonText(value: unknown): string {
	return JSON.stringify(value);
}

function compactJsonByteLength(value: unknown): number {
	return Buffer.byteLength(compactJsonText(value), "utf-8");
}

function mergeLlmContext(details: Record<string, unknown>, additions: Record<string, unknown>): Record<string, unknown> {
	const existingContext = isRecord(details.llm_context) ? details.llm_context : {};
	return {
		...details,
		llm_context: {
			...existingContext,
			...additions,
		},
	};
}

function withRowsSampledForLlm(details: Record<string, unknown>): Record<string, unknown> {
	if (!Array.isArray(details.rows) || details.rows.length <= LLM_ROW_SAMPLE_LIMIT) return details;
	return {
		...mergeLlmContext(details, {
			rows_sampled_for_context: true,
			rows_in_context: LLM_ROW_SAMPLE_LIMIT,
			rows_omitted_from_context: details.rows.length - LLM_ROW_SAMPLE_LIMIT,
			note: "Rows are sampled in LLM context to reduce token usage; use row_count/truncated/result_profile or run a narrower follow-up query if more rows are needed.",
		}),
		rows: details.rows.slice(0, LLM_ROW_SAMPLE_LIMIT),
	};
}

function truncateStringForLlm(value: unknown, maxChars: number): { value: unknown; truncated: boolean } {
	if (typeof value !== "string" || value.length <= maxChars) return { value, truncated: false };
	return { value: `${value.slice(0, maxChars)}...`, truncated: true };
}

function sampleArrayField(
	details: Record<string, unknown>,
	field: string,
	limit: number,
	contextKey: string,
): Record<string, unknown> {
	const value = details[field];
	if (!Array.isArray(value) || value.length <= limit) return details;
	return {
		...mergeLlmContext(details, {
			[`${contextKey}_sampled_for_context`]: true,
			[`${contextKey}_in_context`]: limit,
			[`${contextKey}_omitted_from_context`]: value.length - limit,
		}),
		[field]: value.slice(0, limit),
	};
}

function withDatabasesSampledForLlm(details: Record<string, unknown>): Record<string, unknown> {
	return sampleArrayField(details, "databases", LLM_DATABASE_SAMPLE_LIMIT, "databases");
}

function withTablesSampledForLlm(details: Record<string, unknown>): Record<string, unknown> {
	let shaped = sampleArrayField(details, "tables", LLM_TABLE_SAMPLE_LIMIT, "tables");
	const tables = Array.isArray(shaped.tables) ? new Set(shaped.tables.filter((table): table is string => typeof table === "string")) : undefined;
	if (!Array.isArray(shaped.engine_groups) || !tables) return shaped;
	shaped = {
		...shaped,
		engine_groups: shaped.engine_groups.map((group) => {
			if (!isRecord(group) || !Array.isArray(group.tables)) return group;
			const visibleTables = group.tables.filter((table): table is string => typeof table === "string" && tables.has(table));
			return {
				...group,
				tables: visibleTables,
				count: visibleTables.length,
			};
		}).filter((group) => !isRecord(group) || !Array.isArray(group.tables) || group.tables.length > 0),
	};
	return shaped;
}

function withSearchTablesSampledForLlm(details: Record<string, unknown>): Record<string, unknown> {
	if (!Array.isArray(details.matches)) return details;

	let sampledMatches = details.matches;
	let matchesOmitted = 0;
	if (details.matches.length > LLM_SEARCH_MATCH_LIMIT) {
		sampledMatches = details.matches.slice(0, LLM_SEARCH_MATCH_LIMIT);
		matchesOmitted = details.matches.length - LLM_SEARCH_MATCH_LIMIT;
	}

	let matchedColumnsOmitted = 0;
	const matches = sampledMatches.map((match) => {
		if (!isRecord(match) || !Array.isArray(match.matched_columns) || match.matched_columns.length <= LLM_MATCHED_COLUMN_LIMIT) return match;
		matchedColumnsOmitted += match.matched_columns.length - LLM_MATCHED_COLUMN_LIMIT;
		return {
			...match,
			matched_columns: match.matched_columns.slice(0, LLM_MATCHED_COLUMN_LIMIT),
		};
	});

	if (matchesOmitted === 0 && matchedColumnsOmitted === 0) return details;
	return {
		...mergeLlmContext(details, {
			...(matchesOmitted > 0
				? {
					matches_sampled_for_context: true,
					matches_in_context: LLM_SEARCH_MATCH_LIMIT,
					matches_omitted_from_context: matchesOmitted,
				}
				: {}),
			...(matchedColumnsOmitted > 0
				? {
					matched_columns_sampled_for_context: true,
					matched_columns_per_match_in_context: LLM_MATCHED_COLUMN_LIMIT,
					matched_columns_omitted_from_context: matchedColumnsOmitted,
				}
				: {}),
			note: "Table-search metadata is sampled in LLM context to reduce noise; use narrower filters or max_results for more targeted candidates.",
		}),
		matches,
	};
}

function withDescribeSampledForLlm(details: Record<string, unknown>): Record<string, unknown> {
	let shaped = details;
	shaped = sampleArrayField(shaped, "columns", LLM_DESCRIBE_COLUMN_LIMIT, "columns");
	shaped = sampleArrayField(shaped, "indexes", LLM_DESCRIBE_INDEX_LIMIT, "indexes");
	shaped = sampleArrayField(shaped, "relations", LLM_DESCRIBE_RELATION_LIMIT, "relations");

	const createStatement = truncateStringForLlm(shaped.create_statement, LLM_CREATE_STATEMENT_CHARS);
	if (createStatement.truncated) {
		shaped = {
			...mergeLlmContext(shaped, {
				create_statement_truncated_for_context: true,
				create_statement_chars_in_context: LLM_CREATE_STATEMENT_CHARS,
			}),
			create_statement: createStatement.value,
		};
	}

	if (isRecord(shaped.llm_context)) {
		shaped = mergeLlmContext(shaped, {
			...(typeof shaped.llm_context.note === "string" ? {} : { note: "Table metadata is sampled in LLM context to reduce noise; call sql_describe_table again or use targeted SQL if more detail is needed." }),
		});
	}
	return shaped;
}

function shapeDetailsForLlm(toolName: string, details: unknown): unknown {
	if (!isRecord(details)) return details;

	if (TABULAR_TOOL_NAMES.has(toolName)) {
		return compactJsonByteLength(details) > LLM_FULL_DETAILS_MAX_BYTES ? withRowsSampledForLlm(details) : details;
	}
	const contextShape = SQL_TOOL_CONTEXT_SHAPE_BY_NAME[toolName];
	if (contextShape === "databases") return withDatabasesSampledForLlm(details);
	if (contextShape === "tables") return withTablesSampledForLlm(details);
	if (contextShape === "search") return withSearchTablesSampledForLlm(details);
	if (contextShape === "describe") return withDescribeSampledForLlm(details);

	return details;
}

export function reshapeToolResultsForLlm<T>(messages: T[]): T[] {
	return messages.map((message) => {
		if (!isRecord(message)) return message;
		if (message.role !== "toolResult") return message;
		if (typeof message.toolName !== "string" || !TOOL_NAMES.has(message.toolName)) return message;
		if (!("details" in message)) return message;
		if (isRecord(message.details) && Object.keys(message.details).length === 0) return message;

		const detailsForLlm = shapeDetailsForLlm(message.toolName, message.details);
		return {
			...message,
			content: [{ type: "text", text: compactJsonText(detailsForLlm) }],
		} as T;
	});
}
