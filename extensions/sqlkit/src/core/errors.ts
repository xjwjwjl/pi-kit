import type { ResolvedDataSource } from "../types.js";
import { truncateText } from "../utils.js";

const QUERY_POLICY_PATTERNS = [
	/only read-only/i,
	/write, DDL, administration/i,
	/not allowed in read-only mode/i,
	/forbidden (?:file|lock|write|administration)/i,
	/forbidden write/i,
	/configured as read_only/i,
	/access policy/i,
	/not allowed for source/i,
	/cannot safely validate/i,
	/does not allow .* statements/i,
];

const WRITE_POLICY_PATTERNS = [
	/does not enable allow_apply/i,
	/administration, account, session, file, or high-risk operation/i,
	/only single DML\/DDL/i,
	/supports DML statements only/i,
	/only a single SQL statement/i,
	/sql_(?:write|apply) currently supports/i,
	/access policy/i,
	/not allowed for source/i,
	/cannot safely validate/i,
];

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isPolicyBlocked(message: string): boolean {
	return QUERY_POLICY_PATTERNS.some((pattern) => pattern.test(message));
}

function isWritePolicyBlocked(message: string): boolean {
	return WRITE_POLICY_PATTERNS.some((pattern) => pattern.test(message));
}

function queryPreview(params: { query?: unknown; statement?: unknown } | undefined): string | undefined {
	const text = typeof params?.query === "string"
		? params.query
		: typeof params?.statement === "string"
			? params.statement
			: undefined;
	if (typeof text !== "string") return undefined;
	const compact = text.replace(/\s+/g, " ").trim();
	return compact ? truncateText(compact, 500) : undefined;
}

function sourceSummary(source: ResolvedDataSource | undefined): string | undefined {
	if (!source) return undefined;
	return `${source.name} (${source.dialect}; read_only=${source.readOnly}; allow_apply=${source.allowApply})`;
}

export function makeSqlQueryToolErrorMessage(
	toolName: string,
	params: { query?: unknown; statement?: unknown } | undefined,
	source: ResolvedDataSource | undefined,
	error: unknown,
): { message: string; policyBlocked: boolean } {
	const reason = errorMessage(error);
	if (reason.startsWith("[SQLKIT QUERY ")) {
		return { message: reason, policyBlocked: reason.startsWith("[SQLKIT QUERY BLOCKED") };
	}

	const policyBlocked = isPolicyBlocked(reason);
	const lines = [
		policyBlocked ? "[SQLKIT QUERY BLOCKED - READ/SAFETY POLICY]" : "[SQLKIT QUERY FAILED]",
		`Tool: ${toolName}`,
		`Reason: ${reason}`,
	];
	const sourceText = sourceSummary(source);
	if (sourceText) lines.push(`Source: ${sourceText}`);
	const preview = queryPreview(params);
	if (preview) lines.push(`Query: ${preview}`);

	if (policyBlocked) {
		lines.push(
			"Agent directive: Treat this as a hard SQLKit policy block, not a transient SQL error.",
			"Do not retry this write/DDL/admin operation with sql_run_query, sql_clickhouse_profile_query, sql_explain_query, or sql_mysql_analyze_query.",
			"Do not edit .pi/sqlkit.json, .sqlkit.json, or sqlkit.json merely to bypass read_only, allow_apply, or access-policy settings.",
			"Stop and tell the user SQLKit currently exposes read-oriented query tools; ask them to use an approved migration/admin workflow or explicitly request configuration changes outside this query task.",
		);
	} else {
		lines.push(
			"Agent directive: You may fix SELECT syntax or inspect metadata before retrying read-only SQL.",
			"Modify .pi/sqlkit.json, .sqlkit.json, or sqlkit.json only when the user explicitly asked to change SQLKit datasource configuration.",
		);
	}

	return { message: lines.join("\n"), policyBlocked };
}

export function makeSqlWriteToolErrorMessage(
	toolName: string,
	params: { statement?: unknown } | undefined,
	source: ResolvedDataSource | undefined,
	error: unknown,
): { message: string; policyBlocked: boolean } {
	const reason = errorMessage(error);
	if (reason.startsWith("[SQLKIT WRITE ") || reason.startsWith("[SQLKIT APPLY ")) {
		return {
			message: reason,
			policyBlocked: reason.startsWith("[SQLKIT WRITE BLOCKED") || reason.startsWith("[SQLKIT APPLY BLOCKED"),
		};
	}

	const policyBlocked = isWritePolicyBlocked(reason);
	const lines = [
		policyBlocked ? "[SQLKIT APPLY BLOCKED - SAFETY POLICY]" : "[SQLKIT APPLY FAILED]",
		`Tool: ${toolName}`,
		`Reason: ${reason}`,
	];
	const sourceText = sourceSummary(source);
	if (sourceText) lines.push(`Source: ${sourceText}`);
	const preview = queryPreview(params);
	if (preview) lines.push(`Statement: ${preview}`);

	if (policyBlocked) {
		lines.push(
			"Agent directive: Treat this as a hard SQLKit apply policy block, not a transient SQL error.",
			"Do not retry this write/DDL/admin operation by editing sqlkit.json or by using read-oriented SQL tools.",
			"Stop and tell the user which SQLKit apply policy blocked the statement.",
		);
	} else {
		lines.push("Agent directive: You may correct statement syntax only if the user still wants the write operation.");
	}

	return { message: lines.join("\n"), policyBlocked };
}
