import type {
	ResolvedDataSource,
	VerifiedExplainQuery,
	VerifiedQuery,
	VerifiedQueryReference,
	VerifiedQuerySourcePolicy,
	VerifiedWriteStatement,
} from "../types.js";
import { assertDatabaseAccess, assertQueryAccessFromAnalysis, hasAccessPolicy } from "./access.js";

import { guardExplainableQuery, guardReadOnlyQuery, guardWriteStatement } from "./guards.js";
import { resolveQueryExecutionLimits } from "./limits.js";
import type { SqlStatementAnalysis } from "../sql/analyzer.js";
import { asTrimmedString } from "../utils.js";

const READ_ONLY_QUERY_KINDS = new Set(["select", "show", "describe", "desc", "explain"]);
const ACCESS_POLICY_AMBIGUOUS_QUERY_KINDS = new Set(["show", "describe", "desc"]);
const APPLY_STATEMENT_KINDS = new Set(["insert", "update", "replace", "merge", "create", "alter"]);
const CREATE_DATABASE_IDENTIFIER_PATTERN = String.raw`([A-Za-z_][A-Za-z0-9_$]*|` + "`[^`]+`" + String.raw`|"[^"]+"|\[[^\]]+\])`;

type GuardedQuery = ReturnType<typeof guardReadOnlyQuery>;
type VerifiedQueryBase = Omit<VerifiedQuery, "mode">;

function buildSourcePolicy(source: ResolvedDataSource, accessPolicyEnabled: boolean): VerifiedQuerySourcePolicy {
	return {
		hasAccessPolicy: accessPolicyEnabled,
		readOnly: source.readOnly,
		allowApply: source.allowApply,
	};
}

function resolveVerifiedReferences(
	source: ResolvedDataSource,
	analysis: SqlStatementAnalysis,
	accessPolicyEnabled: boolean,
): VerifiedQueryReference[] {
	const database = asTrimmedString(source.options.database);
	return accessPolicyEnabled
		? assertQueryAccessFromAnalysis(source, analysis, database).references
		: [];
}

function assertNoAmbiguousAccessPolicyQuery(source: ResolvedDataSource, queryKind: string, accessPolicyEnabled: boolean): void {
	if (!accessPolicyEnabled || !ACCESS_POLICY_AMBIGUOUS_QUERY_KINDS.has(queryKind)) return;
	throw new Error(
		`sql_run_query does not allow ${queryKind.toUpperCase()} statements when source "${source.name}" has an access policy. Use sql_list_tables or sql_describe_table instead.`,
	);
}

function enforceVerifiedSourcePolicy(source: ResolvedDataSource, queryKind: string): void {
	if (source.readOnly && !READ_ONLY_QUERY_KINDS.has(queryKind)) {
		throw new Error(`Source \"${source.name}\" is configured as read_only and does not allow ${queryKind.toUpperCase()} queries.`);
	}
}

function enforceWriteSourcePolicy(source: ResolvedDataSource, statementKind: string): void {
	const requiredField = writeCapabilityFieldForStatementKind(statementKind);
	if (requiredField === "allow_apply" && !source.allowApply) {
		throw new Error(`Source "${source.name}" does not enable allow_apply for ${statementKind.toUpperCase()} statements.`);
	}
}

export function writeCapabilityFieldForStatementKind(statementKind: string): "allow_apply" | undefined {
	if (APPLY_STATEMENT_KINDS.has(statementKind)) return "allow_apply";
	return undefined;
}

function unquoteIdentifier(value: string): string {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith("`") && trimmed.endsWith("`")) ||
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("[") && trimmed.endsWith("]"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function extractCreateDatabaseName(statement: string): string | undefined {
	const match = statement.match(
		new RegExp(`^CREATE\\s+(?:DATABASE|SCHEMA)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${CREATE_DATABASE_IDENTIFIER_PATTERN}$`, "i"),
	);
	return match?.[1] ? unquoteIdentifier(match[1]) : undefined;
}

function resolveWriteReferences(source: ResolvedDataSource, guarded: ReturnType<typeof guardWriteStatement>): VerifiedQueryReference[] {
	const createdDatabase = guarded.queryKind === "create" ? extractCreateDatabaseName(guarded.normalizedQuery) : undefined;
	if (createdDatabase) {
		assertDatabaseAccess(source, createdDatabase);
		return [];
	}
	return assertQueryAccessFromAnalysis(source, guarded.analysis, asTrimmedString(source.options.database)).references;
}

function buildVerifiedQueryBase(
	source: ResolvedDataSource,
	guarded: GuardedQuery,
	maxRows: number | undefined,
	options: { rejectAmbiguousAccessPolicyQuery?: boolean } = {},
): VerifiedQueryBase {
	const accessPolicyEnabled = hasAccessPolicy(source);
	if (options.rejectAmbiguousAccessPolicyQuery) {
		assertNoAmbiguousAccessPolicyQuery(source, guarded.queryKind, accessPolicyEnabled);
	}
	enforceVerifiedSourcePolicy(source, guarded.queryKind);
	return {
		dialect: source.dialect,
		sourceName: source.name,
		normalizedQuery: guarded.normalizedQuery,
		queryKind: guarded.queryKind,
		references: resolveVerifiedReferences(source, guarded.analysis, accessPolicyEnabled),
		limits: resolveQueryExecutionLimits(source, maxRows),
		sourcePolicy: buildSourcePolicy(source, accessPolicyEnabled),
	};
}

export function verifyRunQuery(
	source: ResolvedDataSource,
	params: { query: string; maxRows?: number },
): VerifiedQuery {
	return {
		mode: "run",
		...buildVerifiedQueryBase(source, guardReadOnlyQuery(params.query, source.dialect), params.maxRows, {
			rejectAmbiguousAccessPolicyQuery: true,
		}),
	};
}

export function verifyExplainQuery(
	source: ResolvedDataSource,
	params: { query: string; mode?: string; maxRows?: number },
): VerifiedExplainQuery {
	return {
		mode: "explain",
		explainMode: params.mode,
		...buildVerifiedQueryBase(source, guardExplainableQuery(params.query, source.dialect), params.maxRows),
	};
}

export function verifyProfileQuery(
	source: ResolvedDataSource,
	params: { query: string; maxRows?: number },
): VerifiedQuery {
	return {
		mode: "run",
		...buildVerifiedQueryBase(source, guardExplainableQuery(params.query, source.dialect), params.maxRows),
	};
}

export function verifyAnalyzeQuery(
	source: ResolvedDataSource,
	params: { query: string; mode?: string; maxRows?: number },
): VerifiedExplainQuery {
	return verifyExplainQuery(source, params);
}

export function verifyWriteStatement(
	source: ResolvedDataSource,
	params: { statement: string },
): VerifiedWriteStatement {
	const guarded = guardWriteStatement(params.statement, source.dialect);
	enforceWriteSourcePolicy(source, guarded.queryKind);
	const accessPolicyEnabled = hasAccessPolicy(source);
	const references = resolveWriteReferences(source, guarded);
	return {
		mode: "write",
		dialect: source.dialect,
		sourceName: source.name,
		normalizedStatement: guarded.normalizedQuery,
		statementKind: guarded.queryKind,
		references,
		sourcePolicy: buildSourcePolicy(source, accessPolicyEnabled),
	};
}
