import { statSync } from "node:fs";
import {
	assertDatabaseAccess,
	assertTableAccess,
	describeAccessPolicy,
	filterAllowedDatabases,
	filterAllowedTables,
} from "./access.js";
import { getAdapter } from "../adapters/registry.js";
import { loadProjectConfig, resolveSource } from "../config/loader.js";
import { loadProjectConfigDraft, writeProjectConfigDocument } from "../config/store.js";
import { classifySqlStatementKind, SQL_APPLY_SUPPORTED_STATEMENTS } from "./guards.js";
import {
	verifyAnalyzeQuery,
	verifyExplainQuery,
	verifyProfileQuery,
	verifyRunQuery,
	verifyWriteStatement,
} from "./verification.js";
import { makeSqlQueryToolErrorMessage, makeSqlWriteToolErrorMessage } from "./errors.js";
import {
	capabilityFindingsAsIssues,
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
import { policyWarningForSource } from "./policy.js";
import type {
		ValidationIssue,
	AnalyzeQueryResult,
	DescribeTableResult,
	ExplainQueryResult,
	ListSourcesResult,
	ListTablesResult,
	PingResult,
	ProfileQueryResult,
	QueryResult,
	ResolvedDataSource,
	ResolvedProjectConfig,
	SearchTablesInput,
	SearchTablesResult,
	ToolExecutionResult,
	UpsertSourceResult,
	ValidateConfigResult,
	VerifiedWriteStatement,
	WriteStatementResult,
} from "../types.js";
import { asPositiveInt, asTrimmedString } from "../utils.js";

function makeToolResult<TDetails>(details: TDetails, text: string): ToolExecutionResult<TDetails> {
	return { content: [{ type: "text", text }], details };
}

function resolveConfigAndSource(cwd: string, requestedSource?: string): { config: ResolvedProjectConfig; source: ResolvedDataSource } {
	const config = loadProjectConfig(cwd);
	const source = resolveSource(config, requestedSource);
	return { config, source };
}

function normalizeBoundedPositiveInt(value: unknown, fallback: number, min: number, max: number): number {
	const requested = asPositiveInt(value, fallback);
	return Math.min(max, Math.max(min, requested));
}

function normalizeListTablesMaxResults(value: unknown): number {
	return normalizeBoundedPositiveInt(value, 100, 1, 1_000);
}

function normalizeSearchTablesInput(params: {
	database?: string;
	keyword?: string;
	column?: string;
	comment?: string;
	engine?: string;
	min_rows?: number;
	max_results?: number;
}): SearchTablesInput {
	const minRows = typeof params.min_rows === "number" && Number.isFinite(params.min_rows) && params.min_rows >= 0
		? Math.floor(params.min_rows)
		: undefined;
	const requestedMaxResults = asPositiveInt(params.max_results, 20);
	return {
		database: asTrimmedString(params.database),
		keyword: asTrimmedString(params.keyword),
		column: asTrimmedString(params.column),
		comment: asTrimmedString(params.comment),
		engine: asTrimmedString(params.engine),
		minRows,
		maxResults: Math.min(100, Math.max(1, requestedMaxResults)),
	};
}

function filterEngineGroupsByTables(
	engineGroups: ListTablesResult["engine_groups"],
	allowedTables: string[],
): ListTablesResult["engine_groups"] {
	if (!engineGroups) return undefined;
	const allowed = new Set(allowedTables);
	return engineGroups
		.map((group) => {
			const tables = group.tables.filter((table) => allowed.has(table));
			return { ...group, tables, count: tables.length };
		})
		.filter((group) => group.tables.length > 0);
}

function emitQueryToolUpdate(
	onUpdate: ((partial: { content?: Array<{ type: "text"; text: string }> }) => void) | undefined,
	action: string,
	source: ResolvedDataSource,
): void {
	onUpdate?.({
		content: [{ type: "text", text: `${action} on ${source.name} (${source.dialect})...` }],
	});
}

type WriteConfirmationContext = {
	ui?: {
		confirm?: (title: string, message: string) => Promise<boolean> | boolean;
	};
};

function formatWriteReferences(references: VerifiedWriteStatement["references"]): string {
	if (references.length === 0) return "(not extracted)";
	return references.map((ref) => `${ref.database}.${ref.table}`).join(", ");
}

function buildWriteConfirmationMessage(source: ResolvedDataSource, verified: VerifiedWriteStatement): string {
	return [
		`Source: ${source.name} (${source.dialect})`,
		`Kind: ${verified.statementKind.toUpperCase()}`,
		`Target: ${formatWriteReferences(verified.references)}`,
		"",
		"Statement:",
		verified.normalizedStatement,
		"",
		"Confirm execution?",
	].join("\n");
}

function makeWriteNoopResult(
	source: ResolvedDataSource,
	verified: VerifiedWriteStatement,
	input: { cancelled: boolean; warning: string },
): ToolExecutionResult<WriteStatementResult> {
	const details: WriteStatementResult = {
		source: source.name,
		dialect: source.dialect,
		statement_kind: verified.statementKind,
		executed: false,
		cancelled: input.cancelled,
		duration_ms: 0,
		warnings: [input.warning],
	};
	return makeToolResult(details, formatWrite(details));
}

function writeConfigChangeRequirement(
	source: ResolvedDataSource,
	reason: string,
	statementKind?: string,
): WriteStatementResult["requires_config_change"] | undefined {
	const writeMatch = reason.match(/does not enable (allow_apply) for ([A-Z]+) statements/i);
	let field = writeMatch?.[1];
	const reasonStatementKind = writeMatch?.[2]?.toLowerCase();
	let resolvedStatementKind = reasonStatementKind ?? statementKind;
	if (field !== "allow_apply") return undefined;
	if (!resolvedStatementKind) resolvedStatementKind = "unknown";
	return {
		source: source.name,
		field,
		required_value: true,
		reason,
		config_path: source.configPath,
		statement_kind: resolvedStatementKind,
	};
}

function unsupportedWriteStatement(
	reason: string,
	statementKind: string | undefined,
): WriteStatementResult["unsupported_statement"] | undefined {
	if (!/sql_(?:write|apply) currently supports/i.test(reason)) return undefined;
	const resolvedStatementKind = statementKind ?? "unknown";
	return {
		statement_kind: resolvedStatementKind,
		reason,
		supported_shapes: SQL_APPLY_SUPPORTED_STATEMENTS,
	};
}

function makeWritePolicyBlockedResult(
	source: ResolvedDataSource,
	message: string,
	reason: string,
	statement: unknown,
): ToolExecutionResult<WriteStatementResult> | undefined {
	const statementKind = typeof statement === "string" ? classifySqlStatementKind(statement) : undefined;
	const requirement = writeConfigChangeRequirement(source, reason, statementKind);
	const unsupported = unsupportedWriteStatement(reason, statementKind);
	if (!requirement && !unsupported) return undefined;
	const warnings: string[] = [];
	if (requirement) {
		warnings.push(
			"sql_apply did not execute because the datasource configuration does not enable this change capability.",
			"Ask the user before changing sqlkit.json to enable the required capability.",
		);
	}
	if (unsupported) {
		warnings.push("sql_apply did not execute because this SQL statement shape is outside the supported apply subset.");
	}
	const details: WriteStatementResult = {
		source: source.name,
		dialect: source.dialect,
		statement_kind: requirement?.statement_kind ?? unsupported?.statement_kind ?? "unknown",
		executed: false,
		cancelled: false,
		blocked: true,
		requires_config_change: requirement,
		unsupported_statement: unsupported,
		duration_ms: 0,
		warnings,
	};
	const extraLines: string[] = [];
	if (unsupported) {
		extraLines.push("", `Unsupported statement: ${unsupported.reason}`);
		if (unsupported.supported_shapes.length > 0) {
			extraLines.push(`Supported shapes: ${unsupported.supported_shapes.join(", ")}`);
		}
	}
	if (requirement) {
		extraLines.push(
			"",
			`Required config change: set ${source.name}.${requirement.field}=true`,
			"Agent directive: Stop and tell the user this apply operation requires an explicit SQLKit configuration change before retrying.",
		);
	}
	return {
		content: [
			{
				type: "text",
				text: [message, ...extraLines].join("\n"),
			},
		],
		details,
	};
}

function configLoadFix(message: string): string | undefined {
	if (/No sqlkit config found/i.test(message)) {
		return 'Create .pi/sqlkit.json, .sqlkit.json, or sqlkit.json with a top-level object such as {"sources":[{"name":"main","dialect":"mysql","read_only":true,"options":{...}}]}.';
	}
	if (/Failed to read .*JSON|Unexpected token|JSON/i.test(message)) {
		return "Fix the JSON syntax first, then run sql_validate_config again.";
	}
	if (/expected a "sources" array/i.test(message)) {
		return 'Add a top-level "sources" array. Each source entry needs name, dialect, read_only, and options.';
	}
	if (/No SQL sources are configured/i.test(message)) {
		return "Add at least one source entry before using datasource-specific SQL tools.";
	}
	if (/Missing "name"/i.test(message)) {
		return 'Add a unique non-empty "name" to every source entry.';
	}
	if (/Duplicate source name/i.test(message)) {
		return "Rename one of the duplicate sources so each source.name is unique.";
	}
	if (/Invalid dialect/i.test(message)) {
		return 'Set source.dialect to either "mysql" or "clickhouse".';
	}
	if (/Invalid options/i.test(message)) {
		return 'Set source.options to a JSON object containing connection fields such as host, port, user, password, database, or url.';
	}
	if (/Invalid agent_tools/i.test(message)) {
		return 'Set agent_tools to an object such as {"enabled": false}, or remove agent_tools.';
	}
	if (/Invalid access\.databases/i.test(message)) {
		return 'Set access.databases to an object with optional allow and deny string arrays.';
	}
	if (/Invalid access\.tables entry/i.test(message)) {
		return 'Set each access.tables item to an object with optional database plus at least one non-empty allow or deny string array.';
	}
	if (/Invalid access\.tables/i.test(message)) {
		return 'Set access.tables to an array of table-rule objects, or remove access.tables.';
	}
	if (/Invalid access/i.test(message)) {
		return 'Set access to an object such as {"databases":{"allow":["app"]}}, or remove access.';
	}
	return undefined;
}

type UpsertSourceParams = {
	name?: string;
	dialect?: string;
	url?: string;
	read_only?: boolean;
	allow_apply?: boolean;
	options?: Record<string, unknown>;
	access?: Record<string, unknown>;
};

function ensureConfigRootForEdit(cwd: string): { configPath: string; root: Record<string, unknown> } {
	const draft = loadProjectConfigDraft(cwd);
	if (draft.parseError || !draft.rawObject) {
		throw new Error(`Cannot update SQLKit config: ${draft.parseError ?? "config is not a JSON object"}`);
	}
	if (!Array.isArray(draft.rawObject.sources)) draft.rawObject.sources = [];
	return { configPath: draft.configPath, root: draft.rawObject };
}

function normalizeUpsertDialect(params: UpsertSourceParams): "mysql" | "clickhouse" {
	const dialect = params.dialect;
	if (dialect === "mysql" || dialect === "clickhouse") return dialect;
	throw new Error('sql_upsert_source requires dialect to be "mysql" or "clickhouse".');
}

function decodeUrlPart(value: string): string {
	return value ? decodeURIComponent(value) : "";
}

function assignOption(options: Record<string, unknown>, key: string, value: string | number | undefined): void {
	if (value == null || value === "") return;
	if (options[key] == null) options[key] = value;
}

function applyUrlToOptions(options: Record<string, unknown>, dialect: "mysql" | "clickhouse", url: string): void {
	if (dialect === "clickhouse") {
		assignOption(options, "url", url);
		return;
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error("Invalid MySQL url. Expected a mysql://user:password@host:port/database URL.");
	}
	if (!parsed.hostname) throw new Error("Invalid MySQL url. Expected a host.");
	assignOption(options, "host", parsed.hostname);
	if (parsed.port) {
		const port = Number(parsed.port);
		if (Number.isInteger(port) && port > 0) assignOption(options, "port", port);
	}
	assignOption(options, "user", decodeUrlPart(parsed.username));
	assignOption(options, "password", decodeUrlPart(parsed.password));
	assignOption(options, "database", decodeUrlPart(parsed.pathname.replace(/^\/+/, "")));
}

function sourceNameFromParams(params: UpsertSourceParams, dialect: "mysql" | "clickhouse"): string {
	const name = asTrimmedString(params.name);
	if (name) return name;
	return dialect;
}

export function canonicalSourceFromUpsertParams(params: UpsertSourceParams): Record<string, unknown> {
	const dialect = normalizeUpsertDialect(params);
	const name = sourceNameFromParams(params, dialect);
	const allowApply = params.allow_apply === true;
	const source: Record<string, unknown> = {
		name,
		dialect,
		read_only: params.read_only ?? !allowApply,
		allow_apply: allowApply,
		options: { ...(params.options ?? {}) },
	};
	if (params.access) source.access = params.access;
	const url = asTrimmedString(params.url);
	if (url) applyUrlToOptions(source.options as Record<string, unknown>, dialect, url);
	return source;
}

function optionKeysForDisplay(options: unknown): string[] {
	if (!options || typeof options !== "object" || Array.isArray(options)) return [];
	return Object.keys(options as Record<string, unknown>).filter((key) => key !== "password");
}

export async function executeUpsertSource(cwd: string, params: UpsertSourceParams): Promise<ToolExecutionResult<UpsertSourceResult>> {
	const { configPath, root } = ensureConfigRootForEdit(cwd);
	const source = canonicalSourceFromUpsertParams(params);
	const sources = root.sources as Array<Record<string, unknown>>;
	const name = source.name as string;
	const existingIndex = sources.findIndex((item) => asTrimmedString(item.name) === name);
	const created = existingIndex < 0;
	const nextSource = created ? source : { ...sources[existingIndex], ...source };
	if (created) sources.push(nextSource);
	else sources[existingIndex] = nextSource;

	writeProjectConfigDocument(configPath, root);
	const config = loadProjectConfig(cwd);
	const saved = resolveSource(config, name);
	const warnings: string[] = [];
	if (saved.allowApply) warnings.push("allow_apply is enabled; sql_apply will still require user confirmation and only allows supported non-destructive statement shapes.");
	if (!saved.readOnly) warnings.push("read_only is disabled for this source. Read-oriented SQLKit query tools still block DDL/DML/admin SQL.");
	const details: UpsertSourceResult = {
		config_path: saved.configPath,
		source: saved.name,
		dialect: saved.dialect,
		created,
		read_only: saved.readOnly,
		allow_apply: saved.allowApply,
		option_keys: optionKeysForDisplay(saved.options),
		sources_count: config.sources.length,
		warnings,
	};
	return makeToolResult(details, formatUpsertSource(details));
}

export async function executeListSources(cwd: string): Promise<ToolExecutionResult<ListSourcesResult>> {
	const config = loadProjectConfig(cwd);
	const details: ListSourcesResult = {
		config_path: config.configPath,
		sources: config.sources.map((source) => ({
			name: source.name,
			dialect: source.dialect,
			read_only: source.readOnly,
			allow_apply: source.allowApply,
			access: describeAccessPolicy(source),
		})),
	};
	return makeToolResult(details, formatSources(details));
}

export async function executeValidateConfig(
	cwd: string,
	params: { check_connections?: boolean },
	signal?: AbortSignal,
): Promise<ToolExecutionResult<ValidateConfigResult>> {
	let config: ResolvedProjectConfig;
	try {
		config = loadProjectConfig(cwd);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const details: ValidateConfigResult = {
			ok: false,
			sources: [],
			issues: [{ severity: "error", message, fix: configLoadFix(message) }],
		};
		return makeToolResult(details, formatValidateConfig(details));
	}

	const issues = [] as ValidateConfigResult["issues"];
	issues.push(...configFilePermissionIssues(config.configPath));
	const sources: ValidateConfigResult["sources"] = [];
	const checkConnections = params.check_connections !== false;
	for (const source of config.sources) {
		issues.push(...sourceConfigIssues(source));
		const item: ValidateConfigResult["sources"][number] = {
			name: source.name,
			dialect: source.dialect,
			read_only: source.readOnly,
			allow_apply: source.allowApply,
			access: describeAccessPolicy(source),
		};
		const policyWarning = policyWarningForSource(source);
		if (policyWarning) {
			issues.push({ severity: "warning", source: source.name, message: policyWarning });
		}
		if (checkConnections) {
			const adapter = await getAdapter(source.dialect);
			try {
				const ping = await adapter.ping(source, signal);
				item.connection = {
					checked: true,
					ok: true,
					server_version: ping.server_version,
					current_database: ping.current_database,
				};
				for (const warning of ping.warnings) {
					issues.push({ severity: "warning", source: source.name, message: warning });
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				item.connection = { checked: true, ok: false, error: message };
				issues.push({ severity: "error", source: source.name, message: `Connection check failed: ${message}` });
				sources.push(item);
				continue;
			}
			try {
				const capability = await adapter.inspectCapabilities(source, signal);
				item.capability_check = capability;
				issues.push(...capabilityFindingsAsIssues(source.name, capability));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				item.capability_check_error = message;
				issues.push({ severity: "warning", source: source.name, message: `Capability check failed: ${message}` });
			}
		}
		sources.push(item);
	}

	const details: ValidateConfigResult = {
		ok: !issues.some((issue) => issue.severity === "error"),
		config_path: config.configPath,
		sources,
		issues,
	};
	return makeToolResult(details, formatValidateConfig(details));
}

export async function executePing(
	cwd: string,
	params: { source?: string },
	signal?: AbortSignal,
): Promise<ToolExecutionResult<PingResult>> {
	const { source } = resolveConfigAndSource(cwd, params.source);
	const details = await (await getAdapter(source.dialect)).ping(source, signal);
	return makeToolResult(details, formatPing(details));
}

export async function executeListDatabases(
	cwd: string,
	params: { source?: string },
	signal?: AbortSignal,
): Promise<ToolExecutionResult<{ source: string; dialect: string; databases: string[] }>> {
	const { source } = resolveConfigAndSource(cwd, params.source);
	const databases = filterAllowedDatabases(source, await (await getAdapter(source.dialect)).listDatabases(source, signal));
	const details = {
		source: source.name,
		dialect: source.dialect,
		databases,
	};
	return makeToolResult(details, formatDatabases(details));
}

export async function executeListTables(
	cwd: string,
	params: { source?: string; database?: string; like?: string; max_results?: number },
	signal?: AbortSignal,
): Promise<ToolExecutionResult<ListTablesResult>> {
	const { source } = resolveConfigAndSource(cwd, params.source);
	const requestedDatabase = asTrimmedString(params.database) ?? asTrimmedString(source.options.database);
	if (requestedDatabase) {
		assertDatabaseAccess(source, requestedDatabase);
	}
	const maxResults = normalizeListTablesMaxResults(params.max_results);
	const details = await (await getAdapter(source.dialect)).listTables(
		source,
		{ database: params.database, like: params.like, maxResults },
		signal,
	);
	assertDatabaseAccess(source, details.database);
	const filteredTables = filterAllowedTables(source, details.database, details.tables);
	const totalCount = details.truncated !== true ? filteredTables.length : undefined;
	details.tables = filteredTables.slice(0, maxResults);
	details.engine_groups = filterEngineGroupsByTables(details.engine_groups, details.tables);
	details.count = details.tables.length;
	details.total_count = totalCount;
	details.truncated = details.truncated === true || filteredTables.length > maxResults;
	details.max_results = maxResults;
	return makeToolResult(details, formatTables(details));
}

export async function executeSearchTables(
	cwd: string,
	params: {
		source?: string;
		database?: string;
		keyword?: string;
		column?: string;
		comment?: string;
		engine?: string;
		min_rows?: number;
		max_results?: number;
	},
	signal?: AbortSignal,
): Promise<ToolExecutionResult<SearchTablesResult>> {
	const { source } = resolveConfigAndSource(cwd, params.source);
	const input = normalizeSearchTablesInput(params);
	if (input.database) {
		assertDatabaseAccess(source, input.database);
	}
	const details = await (await getAdapter(source.dialect)).searchTables(source, input, signal);
	const allowedMatches = details.matches.filter((match) => {
		try {
			assertTableAccess(source, match.database, match.table);
			return true;
		} catch {
			return false;
		}
	});
	const matches = allowedMatches.slice(0, input.maxResults);
	const filteredDetails: SearchTablesResult = {
		...details,
		filters: {
			...details.filters,
			max_results: input.maxResults,
		},
		matches,
		count: matches.length,
		truncated: details.truncated || allowedMatches.length > input.maxResults,
	};
	return makeToolResult(filteredDetails, formatSearchTables(filteredDetails));
}

export async function executeDescribeTable(
	cwd: string,
	params: { source?: string; database?: string; table: string; include_relations?: boolean },
	signal?: AbortSignal,
): Promise<ToolExecutionResult<DescribeTableResult>> {
	const { source } = resolveConfigAndSource(cwd, params.source);
	const requestedDatabase = asTrimmedString(params.database) ?? asTrimmedString(source.options.database);
	if (requestedDatabase) {
		assertTableAccess(source, requestedDatabase, params.table);
	}
	const details = await (await getAdapter(source.dialect)).describeTable(
		source,
		{
			database: params.database,
			table: params.table,
			includeRelations: params.include_relations === true,
		},
		signal,
	);
	assertTableAccess(source, details.database, details.table);
	return makeToolResult(details, formatDescribe(details));
}

	async function withQueryBlockedCatch<T>(
		toolName: string,
		params: { source?: string; query?: string; statement?: string },
		cwd: string,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: { content?: Array<{ type: "text"; text: string }> }) => void) | undefined,
		actionLabel: string,
		run: (source: ResolvedDataSource) => Promise<T>,
		format: (details: T) => string,
	): Promise<ToolExecutionResult<T>> {
		let source: ResolvedDataSource | undefined;
		try {
			({ source } = resolveConfigAndSource(cwd, params.source));
			emitQueryToolUpdate(onUpdate, actionLabel, source);
			const details = await run(source);
			return makeToolResult(details, format(details));
		} catch (error) {
			const { message, policyBlocked } = makeSqlQueryToolErrorMessage(toolName, params, source, error);
			if (policyBlocked) {
				return { content: [{ type: "text", text: message }], details: {} as T };
			}
			throw new Error(message);
		}
	}

	export async function executeRunQuery(
		cwd: string,
		params: { source?: string; query: string; max_rows?: number },
		signal?: AbortSignal,
		onUpdate?: (partial: { content?: Array<{ type: "text"; text: string }> }) => void,
	): Promise<ToolExecutionResult<QueryResult>> {
		return withQueryBlockedCatch("sql_run_query", params, cwd, signal, onUpdate, "Running query",
			async (source) => {
				const verified = verifyRunQuery(source, { query: params.query, maxRows: params.max_rows });
				return (await getAdapter(source.dialect)).runQuery(source, verified, signal);
			},
			formatQuery,
		);
	}

	export async function executeProfileQuery(
		cwd: string,
		params: { source?: string; query: string; max_rows?: number },
		signal?: AbortSignal,
		onUpdate?: (partial: { content?: Array<{ type: "text"; text: string }> }) => void,
	): Promise<ToolExecutionResult<ProfileQueryResult>> {
		return withQueryBlockedCatch("sql_clickhouse_profile_query", params, cwd, signal, onUpdate, "Profiling query",
			async (source) => {
				const verified = verifyProfileQuery(source, { query: params.query, maxRows: params.max_rows });
				return (await getAdapter(source.dialect)).profileQuery(source, verified, signal);
			},
			formatProfileQuery,
		);
	}

	export async function executeExplainQuery(
		cwd: string,
		params: { source?: string; query: string; mode?: string; max_rows?: number },
		signal?: AbortSignal,
		onUpdate?: (partial: { content?: Array<{ type: "text"; text: string }> }) => void,
	): Promise<ToolExecutionResult<ExplainQueryResult>> {
		return withQueryBlockedCatch("sql_explain_query", params, cwd, signal, onUpdate, "Explaining query",
			async (source) => {
				const verified = verifyExplainQuery(source, { query: params.query, mode: params.mode, maxRows: params.max_rows });
				return (await getAdapter(source.dialect)).explainQuery(source, verified, signal);
			},
			formatExplain,
		);
	}

	export async function executeAnalyzeQuery(
		cwd: string,
		params: { source?: string; query: string; mode?: string; max_rows?: number },
		signal?: AbortSignal,
		onUpdate?: (partial: { content?: Array<{ type: "text"; text: string }> }) => void,
	): Promise<ToolExecutionResult<AnalyzeQueryResult>> {
		return withQueryBlockedCatch("sql_mysql_analyze_query", params, cwd, signal, onUpdate, "Analyzing query",
			async (source) => {
				const verified = verifyAnalyzeQuery(source, { query: params.query, mode: params.mode, maxRows: params.max_rows });
				return (await getAdapter(source.dialect)).analyzeQuery(source, verified, signal);
			},
			formatAnalyze,
		);
	}

export async function executeWrite(
	cwd: string,
	params: { source?: string; statement: string },
	signal?: AbortSignal,
	onUpdate?: (partial: { content?: Array<{ type: "text"; text: string }> }) => void,
	ctx?: WriteConfirmationContext,
): Promise<ToolExecutionResult<WriteStatementResult>> {
	let source: ResolvedDataSource | undefined;
	try {
		({ source } = resolveConfigAndSource(cwd, params.source));
		const verified = verifyWriteStatement(source, { statement: params.statement });
		const confirm = ctx?.ui?.confirm;
		if (typeof confirm !== "function") {
			return makeWriteNoopResult(source, verified, {
				cancelled: false,
				warning: "sql_apply requires interactive user confirmation before execution.",
			});
		}
		const confirmed = await confirm("Confirm SQL apply", buildWriteConfirmationMessage(source, verified));
		if (!confirmed) {
			return makeWriteNoopResult(source, verified, {
				cancelled: true,
				warning: "User cancelled sql_apply before execution.",
			});
		}
		emitQueryToolUpdate(onUpdate, "Applying SQL statement", source);
		const details = await (await getAdapter(source.dialect)).executeStatement(source, verified, signal);
		return makeToolResult(details, formatWrite(details));
	} catch (error) {
		const { message, policyBlocked } = makeSqlWriteToolErrorMessage("sql_apply", params, source, error);
		if (policyBlocked) {
			const reason = error instanceof Error ? error.message : String(error);
			if (source) {
				const blockedResult = makeWritePolicyBlockedResult(source, message, reason, params.statement);
				if (blockedResult) return blockedResult;
			}
			return { content: [{ type: "text", text: message }], details: {} } as ToolExecutionResult<WriteStatementResult>;
		}
		throw new Error(message);
	}
}

// ── 来自 validation.ts ──

function configFilePermissionIssues(configPath: string): ValidationIssue[] {
	try {
		const mode = statSync(configPath).mode & 0o777;
		if (mode & 0o077) {
			return [{
				severity: "warning",
				message: `Config file permissions are too open (mode ${mode.toString(8)}). Group/other users can read this file, which may contain database passwords.`,
				fix: "Restrict permissions, e.g. chmod 600 on the config file, and prefer password_env over options.password.",
			}];
		}
	} catch {
		// File may not exist yet or stat is unsupported — non-fatal.
	}
	return [];
}

function sourceConfigIssues(source: ResolvedDataSource): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	if (!source.readOnly) {
		issues.push({
			severity: "warning",
			source: source.name,
			message: "read_only is disabled.",
			fix: "Set read_only=true for analysis-only sources. Keep it false only when the user explicitly wants this datasource to allow write-capable workflows.",
		});
	}
	if (source.allowApply) {
		issues.push({
			severity: "warning",
			source: source.name,
			message: "allow_apply is enabled.",
			fix: "Keep allow_apply=false unless the user explicitly wants sql_apply to run allowed database changes after confirmation.",
		});
	}
	if (!asTrimmedString(source.options.database)) {
		issues.push({
			severity: "info",
			source: source.name,
			message: "No options.database is set. Some tools will require an explicit database.",
			fix: "Set options.database when most queries should target one database.",
		});
	}
	const passwordEnv = asTrimmedString(source.options.password_env);
	if (source.options.password_env != null && !passwordEnv) {
		issues.push({
			severity: "warning",
			source: source.name,
			message: "password_env is present but empty.",
			fix: "Remove password_env or replace it with a non-empty environment variable name if this source should read the password from the environment.",
		});
	}
	if (passwordEnv && process.env[passwordEnv] == null) {
		issues.push({
			severity: "warning",
			source: source.name,
			message: `Environment variable ${passwordEnv} is not set.`,
			fix: `Set ${passwordEnv} before running SQLKit, or replace password_env with options.password when this project intentionally stores the password in sqlkit.json.`,
		});
	}
	if (source.dialect === "mysql") {
		if (!asTrimmedString(source.options.host) && !asTrimmedString(source.options.socketPath)) {
			issues.push({
				severity: "warning",
				source: source.name,
				message: "MySQL source has no options.host or options.socketPath; mysql2 will use its default host.",
				fix: "Set options.host for TCP connections, or options.socketPath for Unix socket connections.",
			});
		}
		if (!asTrimmedString(source.options.user)) {
			issues.push({
				severity: "warning",
				source: source.name,
				message: "MySQL source has no options.user.",
				fix: "Set options.user to the database account SQLKit should use.",
			});
		}
	}
	if (source.dialect === "clickhouse" && !asTrimmedString(source.options.url) && !asTrimmedString(source.options.host)) {
		issues.push({
			severity: "info",
			source: source.name,
			message: "ClickHouse source has no options.url or options.host; default 127.0.0.1 will be used.",
			fix: "Set options.url for a full ClickHouse HTTP endpoint, or set options.host with optional port/protocol/secure fields.",
		});
	}
	if (source.access.databases.allow.length > 0 || source.access.databases.deny.length > 0 || source.access.tables.length > 0) {
		issues.push({
			severity: "info",
			source: source.name,
			message: `Access policy enabled: ${source.access.databases.allow.length} database allow, ${source.access.databases.deny.length} database deny, ${source.access.tables.length} table rule(s).`,
			fix: "Review access.databases and access.tables when the user expects this source to expose more or fewer databases/tables.",
		});
	} else {
		issues.push({
			severity: "warning",
			source: source.name,
			message: "No access policy is configured. Agents can discover every database/table visible to the database account; configure access.databases.allow/deny or access.tables for long-lived use.",
			fix: "Add access.databases.allow for the intended database names, or add access.tables rules for a tighter table-level scope.",
		});
	}
	if (!asTrimmedString(source.options.database) && source.access.tables.some((rule) => !rule.database)) {
		issues.push({
			severity: "warning",
			source: source.name,
			message: "Table access rules without a database are harder to enforce when no options.database is configured.",
			fix: "Add database to each access.tables rule, or set options.database for this source.",
		});
	}
	return issues;
}
