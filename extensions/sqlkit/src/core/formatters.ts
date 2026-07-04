import type {
	AnalyzeQueryResult,
	CapabilityCheckResult,
	DescribeTableResult,
	ExplainQueryResult,
	ListSourcesResult,
	ListTablesResult,
	PingResult,
	ProfileQueryResult,
	QueryResult,
	ResultColumnProfile,
	SearchTablesResult,
	UpsertSourceResult,
	ValidateConfigResult,
	ValidationIssue,
	WriteStatementResult,
} from "../types.js";
import { truncateText } from "../utils.js";

export function formatSources(details: ListSourcesResult): string {
	const lines: string[] = [];
	lines.push(`Config: ${details.config_path}`);
	lines.push(`Sources: ${details.sources.length}`);
	for (const source of details.sources) {
		const accessBits: string[] = [];
		if (source.access.database_allow.length > 0) accessBits.push(`db allow ${source.access.database_allow.length}`);
		if (source.access.database_deny.length > 0) accessBits.push(`db deny ${source.access.database_deny.length}`);
		if (source.access.table_rules > 0) accessBits.push(`table rules ${source.access.table_rules}`);
		lines.push(
			`- ${source.name} (${source.dialect})${source.read_only ? " readonly" : ""}${accessBits.length > 0 ? ` [${accessBits.join(", ")}]` : ""}`,
		);
	}
	return lines.join("\n");
}

export function formatPing(details: PingResult): string {
	const lines: string[] = [];
	lines.push(`Source: ${details.source} (${details.dialect})`);
	lines.push(details.ok ? "Connection: ok" : "Connection: failed");
	if (details.server_version) lines.push(`Version: ${details.server_version}`);
	if (details.current_database) lines.push(`Database: ${details.current_database}`);
	for (const warning of details.warnings) lines.push(`Warning: ${warning}`);
	return lines.join("\n");
}

export function formatDatabases(details: { source: string; dialect: string; databases: string[] }): string {
	const lines: string[] = [];
	lines.push(`Source: ${details.source} (${details.dialect})`);
	lines.push(`Databases: ${details.databases.length}`);
	for (const database of details.databases) {
		lines.push(`- ${database}`);
	}
	return lines.join("\n");
}

export function formatTables(details: ListTablesResult): string {
	const lines: string[] = [];
	lines.push(`Source: ${details.source} (${details.dialect})`);
	lines.push(`Database: ${details.database}`);
	const totalSuffix = details.total_count == null ? "" : ` of ${details.total_count}`;
	const limitSuffix = details.max_results == null ? "" : `, max_results=${details.max_results}`;
	lines.push(`Tables: ${details.count}${totalSuffix}${details.truncated ? ` (truncated${limitSuffix})` : ""}`);
	if (details.engine_groups && details.engine_groups.length > 0) {
		lines.push("Tables grouped by engine:");
		let emitted = 0;
		for (const group of details.engine_groups) {
			if (emitted >= 50) break;
			lines.push(`- ${group.label} (${group.count})`);
			for (const table of group.tables.slice(0, Math.max(0, 50 - emitted))) {
				lines.push(`  - ${table}`);
				emitted++;
			}
		}
		if (details.tables.length > emitted) {
			lines.push(`... ${details.tables.length - emitted} more returned`);
		}
		return lines.join("\n");
	}
	for (const table of details.tables.slice(0, 50)) {
		lines.push(`- ${table}`);
	}
	if (details.tables.length > 50) {
		lines.push(`... ${details.tables.length - 50} more returned`);
	}
	return lines.join("\n");
}

export function formatSearchTables(details: SearchTablesResult): string {
	const lines: string[] = [];
	lines.push(`Source: ${details.source} (${details.dialect})`);
	lines.push(`Matches: ${details.count}${details.truncated ? " (truncated)" : ""}`);
	const filters = Object.entries(details.filters)
		.filter(([, value]) => value != null && value !== "")
		.map(([key, value]) => `${key}=${value}`);
	if (filters.length > 0) lines.push(`Filters: ${filters.join(", ")}`);
	for (const match of details.matches.slice(0, 30)) {
		const stats: string[] = [];
		if (match.engine) stats.push(match.engine);
		if (match.total_rows != null) stats.push(`rows ${match.total_rows}`);
		if (match.total_bytes != null) stats.push(`bytes ${match.total_bytes}`);
		if (match.matched_on.length > 0) stats.push(`matched ${match.matched_on.join("/")}`);
		lines.push(`- ${match.database}.${match.table}${stats.length > 0 ? ` (${stats.join(", ")})` : ""}`);
		for (const column of match.matched_columns.slice(0, 3)) {
			const comment = column.comment ? ` -- ${truncateText(column.comment, 50)}` : "";
			lines.push(`  column ${column.name}${column.type ? `: ${column.type}` : ""}${comment}`);
		}
	}
	if (details.matches.length > 30) {
		lines.push(`... ${details.matches.length - 30} more matches`);
	}
	return lines.join("\n");
}

export function formatDescribe(details: DescribeTableResult): string {
	const lines: string[] = [];
	lines.push(`Source: ${details.source} (${details.dialect})`);
	lines.push(`Table: ${details.database}.${details.table}`);
	if (details.engine) lines.push(`Engine: ${details.engine}`);
	lines.push(`Columns: ${details.columns.length}`);
	for (const column of details.columns.slice(0, 30)) {
		const comment = column.comment ? ` -- ${truncateText(column.comment, 60)}` : "";
		lines.push(`- ${column.name}: ${column.type}${comment}`);
	}
	if (details.columns.length > 30) {
		lines.push(`... ${details.columns.length - 30} more columns`);
	}
	if (details.relations.length > 0) {
		lines.push(`Relations: ${details.relations.length}`);
	}
	return lines.join("\n");
}

function formatProfileValue(value: unknown): string {
	if (typeof value === "string") return truncateText(value, 40);
	if (value == null || typeof value === "number" || typeof value === "boolean") return String(value);
	try {
		return truncateText(JSON.stringify(value), 40);
	} catch {
		return truncateText(String(value), 40);
	}
}

function formatColumnProfile(column: ResultColumnProfile): string {
	const parts: string[] = [column.inferred_type];
	if (column.null_count > 0) parts.push(`null ${column.null_ratio}`);
	parts.push(`distinct ${column.distinct_non_null_in_sample}`);
	if (column.number) parts.push(`range ${column.number.min}..${column.number.max}`);
	if (!column.number && column.top_values.length > 0) {
		const topValues = column.top_values
			.slice(0, 3)
			.map((entry) => `${formatProfileValue(entry.value)} x${entry.count}`)
			.join(", ");
		parts.push(`top ${topValues}`);
	}
	return `${column.name}: ${parts.join(", ")}`;
}

export function formatQuery(details: QueryResult): string {
	const lines: string[] = [];
	lines.push(`Source: ${details.source} (${details.dialect})`);
	lines.push(`Query kind: ${details.query_kind}`);
	lines.push(`Rows: ${details.row_count}${details.truncated ? " (truncated)" : ""}`);
	if (details.result_profile) {
		lines.push(`Result profile: ${details.result_profile.sampled_rows} sampled row(s), ${details.result_profile.columns.length} column(s)`);
		for (const column of details.result_profile.columns.slice(0, 8)) {
			lines.push(`- ${formatColumnProfile(column)}`);
		}
		if (details.result_profile.columns.length > 8) {
			lines.push(`... ${details.result_profile.columns.length - 8} more profiled columns`);
		}
	}
	lines.push(`Duration: ${details.duration_ms} ms`);
	for (const warning of details.warnings) lines.push(`Warning: ${warning}`);
	return lines.join("\n");
}

export function formatProfileQuery(details: ProfileQueryResult): string {
	const lines = formatQuery(details).split("\n");
	lines.push(`Query ID: ${details.query_id}`);
	lines.push(`Runtime profile: ${details.runtime_profile.status}`);
	if (details.runtime_profile.duration_ms != null) lines.push(`Runtime duration: ${details.runtime_profile.duration_ms} ms`);
	if (details.runtime_profile.read_rows != null) lines.push(`Read rows: ${details.runtime_profile.read_rows}`);
	if (details.runtime_profile.read_bytes != null) lines.push(`Read bytes: ${details.runtime_profile.read_bytes}`);
	if (details.runtime_profile.memory_usage != null) lines.push(`Memory: ${details.runtime_profile.memory_usage}`);
	if (details.runtime_profile.note) lines.push(`Note: ${details.runtime_profile.note}`);
	return lines.join("\n");
}

export function formatExplain(details: ExplainQueryResult): string {
	const lines: string[] = [];
	lines.push(`Source: ${details.source} (${details.dialect})`);
	lines.push(`Query kind: ${details.query_kind}`);
	lines.push(`Explain mode: ${details.explain_mode}`);
	lines.push(`Rows: ${details.row_count}${details.truncated ? " (truncated)" : ""}`);
	lines.push(`Duration: ${details.duration_ms} ms`);
	for (const warning of details.warnings) lines.push(`Warning: ${warning}`);
	return lines.join("\n");
}

export function formatAnalyze(details: AnalyzeQueryResult): string {
	const lines: string[] = [];
	lines.push(`Source: ${details.source} (${details.dialect})`);
	lines.push(`Query kind: ${details.query_kind}`);
	lines.push(`Analyze mode: ${details.analyze_mode}`);
	lines.push(`Rows: ${details.row_count}${details.truncated ? " (truncated)" : ""}`);
	lines.push(`Duration: ${details.duration_ms} ms`);
	for (const warning of details.warnings) lines.push(`Warning: ${warning}`);
	return lines.join("\n");
}

export function formatWrite(details: WriteStatementResult): string {
	const lines: string[] = [];
	lines.push(`Source: ${details.source} (${details.dialect})`);
	lines.push(`Statement kind: ${details.statement_kind}`);
	lines.push(`Executed: ${details.executed ? "yes" : "no"}`);
	if (details.blocked) lines.push("Blocked: yes");
	if (details.cancelled) lines.push("Cancelled: yes");
	if (details.requires_config_change) {
		lines.push(
			`Required config change: set ${details.requires_config_change.source}.${details.requires_config_change.field}=true`,
		);
		lines.push(`Reason: ${details.requires_config_change.reason}`);
	}
	if (details.unsupported_statement) {
		lines.push(`Unsupported statement: ${details.unsupported_statement.reason}`);
		if (details.unsupported_statement.supported_shapes.length > 0) {
			lines.push(`Supported shapes: ${details.unsupported_statement.supported_shapes.join(", ")}`);
		}
	}
	if (details.affected_rows != null) lines.push(`Affected rows: ${details.affected_rows}`);
	if (details.changed_rows != null) lines.push(`Changed rows: ${details.changed_rows}`);
	if (details.warning_count != null) lines.push(`Warning count: ${details.warning_count}`);
	if (details.query_id) lines.push(`Query ID: ${details.query_id}`);
	lines.push(`Duration: ${details.duration_ms} ms`);
	for (const warning of details.warnings) lines.push(`Warning: ${warning}`);
	return lines.join("\n");
}

export function formatValidateConfig(details: ValidateConfigResult): string {
	const lines: string[] = [];
	lines.push(details.ok ? "Config: ok" : "Config: has issues");
	if (details.config_path) lines.push(`Path: ${details.config_path}`);
	lines.push(`Sources: ${details.sources.length}`);
	for (const source of details.sources) {
		const connection = source.connection
			? source.connection.checked
				? source.connection.ok
					? " connection ok"
					: " connection failed"
				: ""
			: "";
		const capabilitySuffix = source.capability_check?.checked
			? ` capability ${source.capability_check.findings.length} finding(s)`
			: source.capability_check_error
				? " capability check failed"
			: "";
		lines.push(`- ${source.name} (${source.dialect})${source.read_only ? " readonly" : ""}${connection}${capabilitySuffix}`);
	}
	if (details.issues.length > 0) {
		lines.push(`Issues: ${details.issues.length}`);
		for (const issue of details.issues.slice(0, 20)) {
			const source = issue.source ? `${issue.source}: ` : "";
			lines.push(`- ${issue.severity}: ${source}${issue.message}`);
			if (issue.fix) lines.push(`  fix: ${issue.fix}`);
		}
	}
	return lines.join("\n");
}

export function formatUpsertSource(details: UpsertSourceResult): string {
	const lines: string[] = [];
	lines.push(`Config: ${details.config_path}`);
	lines.push(`${details.created ? "Created" : "Updated"} source: ${details.source} (${details.dialect})`);
	lines.push(`read_only: ${details.read_only}`);
	lines.push(`allow_apply: ${details.allow_apply}`);
	lines.push(`options: ${details.option_keys.join(", ") || "(none)"}`);
	lines.push(`Sources: ${details.sources_count}`);
	for (const warning of details.warnings) lines.push(`Warning: ${warning}`);
	return lines.join("\n");
}

export function capabilityFindingsAsIssues(sourceName: string, capability: CapabilityCheckResult): ValidationIssue[] {
	return capability.findings.map((finding) => ({
		severity: finding.severity,
		source: sourceName,
		message: `[${finding.code}] ${finding.message}`,
	}));
}
