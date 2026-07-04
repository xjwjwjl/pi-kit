export type SqlDialect = "mysql" | "clickhouse";

export type JsonRecord = Record<string, unknown>;

export type ResolvedTableAccessRule = {
	database?: string;
	allow: string[];
	deny: string[];
};

export type ResolvedAccessPolicy = {
	databases: {
		allow: string[];
		deny: string[];
	};
	tables: ResolvedTableAccessRule[];
};

export type ResolvedDataSource = {
	name: string;
	dialect: SqlDialect;
	readOnly: boolean;
	allowApply: boolean;
	access: ResolvedAccessPolicy;
	options: JsonRecord;
	configPath: string;
	cacheKey: string;
};

export type ResolvedAgentToolsConfig = {
	enabled?: boolean;
};

export type ResolvedProjectConfig = {
	configPath: string;
	agentTools: ResolvedAgentToolsConfig;
	sources: ResolvedDataSource[];
};

export type CapabilityFinding = {
	severity: "error" | "warning" | "info";
	code: string;
	message: string;
};

export type CapabilityCheckResult = {
	checked: boolean;
	current_user?: string;
	grants_inspected: boolean;
	grant_count: number;
	privileges: string[];
	readonly_setting?: number;
	allow_ddl_setting?: number;
	findings: CapabilityFinding[];
};

export type PingResult = {
	source: string;
	dialect: SqlDialect;
	ok: boolean;
	server_version?: string;
	current_database?: string;
	warnings: string[];
};

export type ListSourcesResult = {
	config_path: string;
	sources: Array<{
		name: string;
		dialect: SqlDialect;
		read_only: boolean;
		allow_apply: boolean;
		access: {
			database_allow: string[];
			database_deny: string[];
			table_rules: number;
		};
	}>;
};

export type TableEngineGroup = {
	engine: string;
	label: string;
	count: number;
	tables: string[];
};

export type ListTablesResult = {
	source: string;
	dialect: SqlDialect;
	database: string;
	tables: string[];
	engine_groups?: TableEngineGroup[];
	count: number;
	total_count?: number;
	truncated?: boolean;
	max_results?: number;
};

export type SearchTablesInput = {
	database?: string;
	keyword?: string;
	column?: string;
	comment?: string;
	engine?: string;
	minRows?: number;
	maxResults: number;
};

export type SearchTableColumnMatch = {
	name: string;
	type?: string;
	comment?: string | null;
	matched_on: string[];
};

export type SearchTableMatch = {
	qualified_name: string;
	database: string;
	table: string;
	engine?: string;
	table_type?: string;
	comment?: string | null;
	total_rows?: number | null;
	total_bytes?: number | null;
	matched_on: string[];
	matched_columns: SearchTableColumnMatch[];
};

export type SearchTablesResult = {
	source: string;
	dialect: SqlDialect;
	filters: {
		database?: string;
		keyword?: string;
		column?: string;
		comment?: string;
		engine?: string;
		min_rows?: number;
		max_results: number;
	};
	matches: SearchTableMatch[];
	count: number;
	truncated: boolean;
};

export type ColumnInfo = {
	name: string;
	type: string;
	nullable?: boolean;
	default?: string | null;
	comment?: string | null;
	position?: number;
};

export type IndexInfo = {
	name: string;
	type?: string;
	columns: string[];
	unique?: boolean;
};

export type RelationInfo = {
	name?: string;
	column: string;
	referenced_database?: string;
	referenced_table: string;
	referenced_column: string;
};

export type DescribeTableResult = {
	source: string;
	dialect: SqlDialect;
	database: string;
	table: string;
	engine?: string;
	columns: ColumnInfo[];
	indexes: IndexInfo[];
	relations: RelationInfo[];
	create_statement?: string;
};

export type QueryResult = {
	source: string;
	dialect: SqlDialect;
	query_kind: string;
	columns: string[];
	rows: unknown[][];
	row_count: number;
	truncated: boolean;
	result_profile?: ResultProfile;
	duration_ms: number;
	warnings: string[];
};

export type ResultProfileValueCount = {
	value: unknown;
	count: number;
};

export type ResultColumnProfile = {
	name: string;
	inferred_type: "null" | "integer" | "float" | "number" | "boolean" | "string" | "mixed" | "unknown";
	null_count: number;
	non_null_count: number;
	null_ratio: number;
	distinct_non_null_in_sample: number;
	sample_values: unknown[];
	top_values: ResultProfileValueCount[];
	number?: {
		min: number;
		max: number;
		avg: number;
	};
	string?: {
		min_length: number;
		max_length: number;
		avg_length: number;
	};
};

export type ResultProfile = {
	profile_scope: "sampled_result_rows";
	sampled_rows: number;
	columns: ResultColumnProfile[];
};

export type ExplainQueryResult = {
	source: string;
	dialect: SqlDialect;
	query_kind: string;
	explain_mode: string;
	columns: string[];
	rows: unknown[][];
	row_count: number;
	truncated: boolean;
	duration_ms: number;
	warnings: string[];
};

export type QueryRuntimeProfileEvent = {
	name: string;
	value: number;
};

export type QueryRuntimeProfile = {
	status: "available" | "unavailable";
	note?: string;
	query_id?: string;
	duration_ms?: number;
	read_rows?: number;
	read_bytes?: number;
	result_rows?: number;
	result_bytes?: number;
	memory_usage?: number;
	databases?: string[];
	tables?: string[];
	columns?: string[];
	used_functions?: string[];
	used_storages?: string[];
	profile_events?: QueryRuntimeProfileEvent[];
};

export type ProfileQueryResult = QueryResult & {
	query_id: string;
	runtime_profile: QueryRuntimeProfile;
};

export type AnalyzeQueryResult = {
	source: string;
	dialect: SqlDialect;
	query_kind: string;
	analyze_mode: string;
	columns: string[];
	rows: unknown[][];
	row_count: number;
	truncated: boolean;
	duration_ms: number;
	warnings: string[];
};

export type WriteStatementResult = {
	source: string;
	dialect: SqlDialect;
	statement_kind: string;
	executed: boolean;
	cancelled: boolean;
	blocked?: boolean;
	requires_config_change?: {
		source: string;
		field: "allow_apply";
		required_value: true;
		reason: string;
		config_path?: string;
		statement_kind?: string;
	};
	unsupported_statement?: {
		statement_kind: string;
		reason: string;
		supported_shapes: string[];
	};
	affected_rows?: number;
	changed_rows?: number;
	warning_count?: number;
	query_id?: string;
	duration_ms: number;
	warnings: string[];
};

export type VerifiedQueryReference = {
	database: string;
	table: string;
};

export type VerifiedQuerySourcePolicy = {
	hasAccessPolicy: boolean;
	readOnly: boolean;
	allowApply: boolean;
};

export type VerifiedQuery = {
	mode: "run";
	dialect: SqlDialect;
	sourceName: string;
	normalizedQuery: string;
	queryKind: string;
	references: VerifiedQueryReference[];
	limits: QueryExecutionLimits;
	sourcePolicy: VerifiedQuerySourcePolicy;
};

export type VerifiedExplainQuery = {
	mode: "explain";
	dialect: SqlDialect;
	sourceName: string;
	normalizedQuery: string;
	queryKind: string;
	references: VerifiedQueryReference[];
	limits: QueryExecutionLimits;
	explainMode?: string;
	sourcePolicy: VerifiedQuerySourcePolicy;
};

export type VerifiedWriteStatement = {
	mode: "write";
	dialect: SqlDialect;
	sourceName: string;
	normalizedStatement: string;
	statementKind: string;
	references: VerifiedQueryReference[];
	sourcePolicy: VerifiedQuerySourcePolicy;
};

export type QueryExecutionLimits = {
	maxRows: number;
	fetchRows: number;
	maxResultBytes: number;
	maxCellChars: number;
};

export type ValidationIssue = {
	severity: "error" | "warning" | "info";
	message: string;
	source?: string;
	fix?: string;
};

export type ValidateConfigResult = {
	ok: boolean;
	config_path?: string;
	sources: Array<{
		name: string;
		dialect: SqlDialect;
		read_only: boolean;
		allow_apply: boolean;
		access: {
			database_allow: string[];
			database_deny: string[];
			table_rules: number;
		};
		capability_check?: CapabilityCheckResult;
		capability_check_error?: string;
		connection?: {
			checked: boolean;
			ok?: boolean;
			server_version?: string;
			current_database?: string;
			error?: string;
		};
	}>;
	issues: ValidationIssue[];
};

export type UpsertSourceResult = {
	config_path: string;
	source: string;
	dialect: SqlDialect;
	created: boolean;
	read_only: boolean;
	allow_apply: boolean;
	option_keys: string[];
	sources_count: number;
	warnings: string[];
};

export type ToolExecutionResult<TDetails> = {
	content: Array<{ type: "text"; text: string }>;
	details: TDetails;
};

export type DialectAdapter = {
	dialect: SqlDialect;
	ping(source: ResolvedDataSource, signal?: AbortSignal): Promise<PingResult>;
	listDatabases(source: ResolvedDataSource, signal?: AbortSignal): Promise<string[]>;
	listTables(
		source: ResolvedDataSource,
		input: { database?: string; like?: string; maxResults?: number },
		signal?: AbortSignal,
	): Promise<ListTablesResult>;
	searchTables(
		source: ResolvedDataSource,
		input: SearchTablesInput,
		signal?: AbortSignal,
	): Promise<SearchTablesResult>;
	describeTable(
		source: ResolvedDataSource,
		input: { database?: string; table: string; includeRelations?: boolean },
		signal?: AbortSignal,
	): Promise<DescribeTableResult>;
	inspectCapabilities(source: ResolvedDataSource, signal?: AbortSignal): Promise<CapabilityCheckResult>;
	runQuery(
		source: ResolvedDataSource,
		input: VerifiedQuery,
		signal?: AbortSignal,
	): Promise<QueryResult>;
	profileQuery(
		source: ResolvedDataSource,
		input: VerifiedQuery,
		signal?: AbortSignal,
	): Promise<ProfileQueryResult>;
	explainQuery(
		source: ResolvedDataSource,
		input: VerifiedExplainQuery,
		signal?: AbortSignal,
	): Promise<ExplainQueryResult>;
	analyzeQuery(
		source: ResolvedDataSource,
		input: VerifiedExplainQuery,
		signal?: AbortSignal,
	): Promise<AnalyzeQueryResult>;
	executeStatement(
		source: ResolvedDataSource,
		input: VerifiedWriteStatement,
		signal?: AbortSignal,
	): Promise<WriteStatementResult>;
};
