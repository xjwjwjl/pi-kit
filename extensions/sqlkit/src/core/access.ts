// ============================================================
// 访问控制 —— 数据库/表 deny/allow 策略执行 + 查询引用验证
// ============================================================
// 合并自: access-policy.ts, access-common.ts, query-access.ts
import type { ResolvedDataSource, ResolvedTableAccessRule, VerifiedQueryReference } from "../types.js";
import { asTrimmedString } from "../utils.js";
import { analyzeSql } from "../sql/analyzer.js";
import type { SqlStatementAnalysis } from "../sql/analyzer.js";

function sourceDatabaseOption(source: ResolvedDataSource): string | undefined {
	return asTrimmedString(source.options.database);
}

// ── §1 标识符规范化 ──

export function normalizeIdentifier(value: string): string {
	return value.trim().replace(/^["`\[]+|["`\]]+$/g, "").toLowerCase();
}

// ── §2 通配符匹配引擎 ──

function uniqueNormalized(values: string[]): string[] {
	return Array.from(new Set(values.map(normalizeIdentifier).filter(Boolean)));
}

export function normalizeAccessPatterns(values: string[]): string[] {
	return uniqueNormalized(values);
}

function matchesPattern(name: string, pattern: string): boolean {
	// Safe glob matching: split by *, match segments sequentially.
	// Avoids catastrophic backtracking (ReDoS) inherent in .* regex chains.
	const lower = name.toLowerCase();
	const parts = pattern.toLowerCase().split("*");
	if (parts.length === 1) return lower === parts[0];
	if (parts[0] && !lower.startsWith(parts[0])) return false;
	let pos = parts[0].length;
	for (let i = 1; i < parts.length - 1; i++) {
		const segment = parts[i];
		if (!segment) continue;
		const found = lower.indexOf(segment, pos);
		if (found === -1) return false;
		pos = found + segment.length;
	}
	const last = parts[parts.length - 1];
	return !last || lower.endsWith(last, lower.length);
}

// ── §3 策略检测 ──

export function findTableRules(source: ResolvedDataSource, database: string): ResolvedTableAccessRule[] {
	const normalizedDatabase = normalizeIdentifier(database);
	return source.access.tables.filter((rule) => {
		if (!rule.database) return true;
		return normalizeIdentifier(rule.database) === normalizedDatabase;
	});
}

export function tableAccessPatternsForDatabase(
	source: ResolvedDataSource,
	database: string,
): { allow: string[]; deny: string[] } | undefined {
	const rules = findTableRules(source, database);
	if (rules.length === 0) return undefined;
	return {
		allow: uniqueNormalized(rules.flatMap((rule) => rule.allow)),
		deny: uniqueNormalized(rules.flatMap((rule) => rule.deny)),
	};
}

function evaluateList(name: string, allow: string[], deny: string[]): { allowed: boolean; reason?: string } {
	const normalizedName = normalizeIdentifier(name);
	const normalizedAllow = uniqueNormalized(allow);
	const normalizedDeny = uniqueNormalized(deny);

	for (const pattern of normalizedDeny) {
		if (matchesPattern(normalizedName, pattern)) {
			return { allowed: false, reason: `matched deny rule "${pattern}"` };
		}
	}
	if (normalizedAllow.length > 0) {
		for (const pattern of normalizedAllow) {
			if (matchesPattern(normalizedName, pattern)) {
				return { allowed: true };
			}
		}
		return { allowed: false, reason: "not included in allow list" };
	}
	return { allowed: true };
}

export function describeAccessPolicy(source: ResolvedDataSource): {
	database_allow: string[];
	database_deny: string[];
	table_rules: number;
} {
	return {
		database_allow: [...source.access.databases.allow],
		database_deny: [...source.access.databases.deny],
		table_rules: source.access.tables.length,
	};
}

export function hasAccessPolicy(source: ResolvedDataSource): boolean {
	return (
		source.access.databases.allow.length > 0 ||
		source.access.databases.deny.length > 0 ||
		source.access.tables.length > 0
	);
}

// ── §4 数据库级检查 ──

export function assertDatabaseAccess(source: ResolvedDataSource, database: string): void {
	const normalized = asTrimmedString(database);
		if (!normalized) {
			throw new Error(
				`Access to database "" is not allowed for source "${source.name}" (empty database name).`,
			);
		}
	const result = evaluateList(normalized, source.access.databases.allow, source.access.databases.deny);
	if (!result.allowed) {
		throw new Error(
			`Access to database "${database}" is not allowed for source "${source.name}" (${result.reason ?? "blocked by access policy"}).`,
		);
	}
}

export function filterAllowedDatabases(source: ResolvedDataSource, databases: string[]): string[] {
	return databases.filter((database) => {
		try {
			assertDatabaseAccess(source, database);
			return true;
		} catch {
			return false;
		}
	});
}

// ── §5 表级检查 ──

export function assertTableAccess(source: ResolvedDataSource, database: string, table: string): void {
	assertDatabaseAccess(source, database);
	const normalizedTable = asTrimmedString(table);
	if (!normalizedTable) return;
	const rules = findTableRules(source, database);
	if (rules.length === 0) return;
	const allow = rules.flatMap((rule) => rule.allow);
	const deny = rules.flatMap((rule) => rule.deny);
	const result = evaluateList(normalizedTable, allow, deny);
	if (!result.allowed) {
		throw new Error(
			`Access to table "${database}.${table}" is not allowed for source "${source.name}" (${result.reason ?? "blocked by access policy"}).`,
		);
	}
}

export function filterAllowedTables(source: ResolvedDataSource, database: string, tables: string[]): string[] {
	return tables.filter((table) => {
		try {
			assertTableAccess(source, database, table);
			return true;
		} catch {
			return false;
		}
	});
}

// ── §6 查询引用检查 (原 query-access.ts) ──

export function assertQueryAccessFromAnalysis(
	source: ResolvedDataSource,
	analysis: SqlStatementAnalysis,
	explicitDatabase?: string,
): { references: VerifiedQueryReference[] } {
	const unsafeSource = analysis.unsafeSources[0];
	if (unsafeSource) {
		throw new Error(
			`Query access policy for source "${source.name}" cannot safely validate source expressions such as "${unsafeSource.source}". Use explicit database.table references instead.`,
		);
	}
	if (analysis.references.length === 0) {
		if (analysis.hasSourceClause && hasAccessPolicy(source)) {
			throw new Error(
				`Query access policy for source "${source.name}" requires explicit table references that can be checked safely.`,
			);
		}
		return { references: [] };
	}

	const resolvedRefs = analysis.references.map((ref) => {
		const database = asTrimmedString(ref.database) ?? explicitDatabase ?? sourceDatabaseOption(source);
		if (!database) {
			throw new Error(
				`Query for source "${source.name}" references table "${ref.table}" without a database, and no options.database is configured.`,
			);
		}
		assertTableAccess(source, database, ref.table);
		return { database, table: ref.table };
	});

	return { references: resolvedRefs };
}

export function assertQueryAccess(
	source: ResolvedDataSource,
	query: string,
	explicitDatabase?: string,
): { references: VerifiedQueryReference[] } {
	return assertQueryAccessFromAnalysis(source, analyzeSql(query, source.dialect), explicitDatabase);
}
