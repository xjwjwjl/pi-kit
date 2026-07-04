import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { asBoolean, asTrimmedString, isRecord, readPasswordOption } from "../utils.js";
import type {
	JsonRecord,
	ResolvedAccessPolicy,
	ResolvedAgentToolsConfig,
	ResolvedDataSource,
	ResolvedProjectConfig,
	ResolvedTableAccessRule,
	SqlDialect,
} from "../types.js";

const CONFIG_FILE_CANDIDATES = [
	path.join(".pi", "sqlkit.json"),
	".sqlkit.json",
	"sqlkit.json",
];

type ConfigCacheEntry = {
	mtimeMs: number;
	size: number;
	config: ResolvedProjectConfig;
};

const configCache = new Map<string, ConfigCacheEntry>();

export function findProjectConfigPath(startDir: string): string | undefined {
	let current = path.resolve(startDir);
	while (true) {
		for (const candidate of CONFIG_FILE_CANDIDATES) {
			const fullPath = path.join(current, candidate);
			if (existsSync(fullPath)) return fullPath;
		}
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export function resolveProjectConfigPathForWrite(cwd: string): string {
	return findProjectConfigPath(cwd) ?? path.join(path.resolve(cwd), ".pi", "sqlkit.json");
}

function normalizeDialect(value: unknown, sourceName: string, configPath: string): SqlDialect {
	if (value === "mysql" || value === "clickhouse") return value;
	throw new Error(`Invalid dialect for source "${sourceName}" in ${configPath}. Expected "mysql" or "clickhouse".`);
}

function normalizeOptions(value: unknown, sourceName: string, configPath: string): JsonRecord {
	if (!isRecord(value)) {
		throw new Error(`Invalid options for source "${sourceName}" in ${configPath}. Expected a JSON object.`);
	}
	return value;
}

function assignIfMissing(options: JsonRecord, key: string, value: string | number | undefined): void {
	if (value == null || value === "") return;
	if (options[key] == null) options[key] = value;
}

function applyMysqlUrlOptions(options: JsonRecord, sourceName: string, configPath: string, url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`Invalid MySQL url for source "${sourceName}" in ${configPath}. Expected a mysql:// connection URL.`);
	}
	if (!parsed.hostname) {
		throw new Error(`Invalid MySQL url for source "${sourceName}" in ${configPath}. Expected a host in the connection URL.`);
	}
	assignIfMissing(options, "host", parsed.hostname);
	if (parsed.port) {
		const port = Number(parsed.port);
		if (Number.isInteger(port) && port > 0) assignIfMissing(options, "port", port);
	}
	assignIfMissing(options, "user", decodeURIComponent(parsed.username));
	assignIfMissing(options, "password", decodeURIComponent(parsed.password));
	const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
	assignIfMissing(options, "database", database);
}

function normalizeSourceOptions(value: Record<string, unknown>, dialect: SqlDialect, sourceName: string, configPath: string): JsonRecord {
	const topLevelUrl = asTrimmedString(value.url);
	const options = value.options == null && topLevelUrl ? {} : { ...normalizeOptions(value.options, sourceName, configPath) };
	if (!topLevelUrl) return options;

	if (dialect === "mysql") {
		applyMysqlUrlOptions(options, sourceName, configPath, topLevelUrl);
		return options;
	}

	assignIfMissing(options, "url", topLevelUrl);
	return options;
}

function normalizeStringList(
	value: unknown,
	fieldName: string,
	sourceName: string,
	configPath: string,
): string[] {
	if (value == null) return [];
	if (!Array.isArray(value)) {
		throw new Error(`Invalid ${fieldName} for source "${sourceName}" in ${configPath}. Expected an array of strings.`);
	}
	const output: string[] = [];
	for (const item of value) {
		const normalized = asTrimmedString(item);
		if (!normalized) {
			throw new Error(`Invalid ${fieldName} for source "${sourceName}" in ${configPath}. Expected non-empty strings.`);
		}
		output.push(normalized);
	}
	return output;
}

function normalizeTableRule(value: unknown, sourceName: string, configPath: string): ResolvedTableAccessRule {
	if (!isRecord(value)) {
		throw new Error(`Invalid access.tables entry for source "${sourceName}" in ${configPath}. Expected a JSON object.`);
	}
	const database = asTrimmedString(value.database);
	const allow = normalizeStringList(value.allow, "access.tables.allow", sourceName, configPath);
	const deny = normalizeStringList(value.deny, "access.tables.deny", sourceName, configPath);
	if (allow.length === 0 && deny.length === 0) {
		throw new Error(`Invalid access.tables entry for source "${sourceName}" in ${configPath}. At least one of allow or deny is required.`);
	}
	return { database, allow, deny };
}

function normalizeAccessPolicy(value: unknown, sourceName: string, configPath: string): ResolvedAccessPolicy {
	if (value == null) {
		return {
			databases: { allow: [], deny: [] },
			tables: [],
		};
	}
	if (!isRecord(value)) {
		throw new Error(`Invalid access for source "${sourceName}" in ${configPath}. Expected a JSON object.`);
	}
	const rawDatabases = value.databases;
	let databasesAllow: string[] = [];
	let databasesDeny: string[] = [];
	if (rawDatabases != null) {
		if (!isRecord(rawDatabases)) {
			throw new Error(`Invalid access.databases for source "${sourceName}" in ${configPath}. Expected a JSON object.`);
		}
		databasesAllow = normalizeStringList(rawDatabases.allow, "access.databases.allow", sourceName, configPath);
		databasesDeny = normalizeStringList(rawDatabases.deny, "access.databases.deny", sourceName, configPath);
	}
	const tableRulesRaw = value.tables;
	const tableRules = tableRulesRaw == null
		? []
		: Array.isArray(tableRulesRaw)
			? tableRulesRaw.map((item) => normalizeTableRule(item, sourceName, configPath))
			: (() => {
				throw new Error(`Invalid access.tables for source "${sourceName}" in ${configPath}. Expected an array.`);
			})();

	return {
		databases: {
			allow: databasesAllow,
			deny: databasesDeny,
		},
		tables: tableRules,
	};
}


function redactedOptionsForCacheKey(options: JsonRecord): JsonRecord {
	const redacted: JsonRecord = { ...options };
	if ("password" in redacted) redacted.password = "<redacted>";
	if (typeof redacted.url === "string") redacted.url = redactUrlCredentials(redacted.url);
	return redacted;
}

function redactUrlCredentials(value: string): string {
	try {
		const parsed = new URL(value);
		if (parsed.username) parsed.username = "<redacted>";
		if (parsed.password) parsed.password = "<redacted>";
		return parsed.toString();
	} catch {
		return value;
	}
}

function buildSourceCacheKey(source: Omit<ResolvedDataSource, "cacheKey">): string {
	const password = readPasswordOption(source.options);
	return JSON.stringify({
		configPath: source.configPath,
		name: source.name,
		dialect: source.dialect,
		readOnly: source.readOnly,
		allowApply: source.allowApply,
		access: source.access,
		options: redactedOptionsForCacheKey(source.options),
		passwordFingerprint: password ? createHash("sha256").update(password).digest("hex") : "",
	});
}

function refreshSourceCacheKey(source: ResolvedDataSource): void {
	source.cacheKey = buildSourceCacheKey(source);
}

function refreshProjectConfigCacheKeys(config: ResolvedProjectConfig): ResolvedProjectConfig {
	for (const source of config.sources) refreshSourceCacheKey(source);
	return config;
}

function normalizeAgentTools(value: unknown, configPath: string): ResolvedAgentToolsConfig {
	if (value == null) return {};
	if (!isRecord(value)) {
		throw new Error(`Invalid agent_tools in ${configPath}. Expected a JSON object.`);
	}
	const enabled = value.enabled == null ? undefined : asBoolean(value.enabled, false);
	return { enabled };
}

function normalizeSource(value: unknown, configPath: string): ResolvedDataSource {
	if (!isRecord(value)) {
		throw new Error(`Invalid source entry in ${configPath}. Expected a JSON object.`);
	}

	const name = asTrimmedString(value.name);
	if (!name) {
		throw new Error(`Invalid source entry in ${configPath}. Missing "name".`);
	}
	const allowApply = asBoolean(value.allow_apply, false);
	const dialect = normalizeDialect(value.dialect, name, configPath);

	const sourceWithoutCacheKey: Omit<ResolvedDataSource, "cacheKey"> = {
		name,
		dialect,
		readOnly: asBoolean(value.read_only, !allowApply),
		allowApply,
		access: normalizeAccessPolicy(value.access, name, configPath),
		options: normalizeSourceOptions(value, dialect, name, configPath),
		configPath,
	};

	return {
		...sourceWithoutCacheKey,
		cacheKey: buildSourceCacheKey(sourceWithoutCacheKey),
	};
}

export function validateProjectConfigData(parsed: unknown, configPath: string): ResolvedProjectConfig {
	if (!isRecord(parsed)) {
		throw new Error(`Invalid ${configPath}: expected a JSON object.`);
	}

	const rawSources = parsed.sources;
	if (!Array.isArray(rawSources)) {
		throw new Error(`Invalid ${configPath}: expected a "sources" array.`);
	}

	const sources = rawSources.map((item) => normalizeSource(item, configPath));
	const seenNames = new Set<string>();
	for (const source of sources) {
		if (seenNames.has(source.name)) {
			throw new Error(`Duplicate source name "${source.name}" in ${configPath}.`);
		}
		seenNames.add(source.name);
	}

	return {
		configPath,
		agentTools: normalizeAgentTools(parsed.agent_tools, configPath),
		sources,
	};
}

export function clearProjectConfigCache(): void {
	configCache.clear();
}

export function loadProjectConfig(cwd: string): ResolvedProjectConfig {
	const configPath = findProjectConfigPath(cwd);
	if (!configPath) {
		throw new Error(`No sqlkit config found for ${cwd}. Create .pi/sqlkit.json, .sqlkit.json, or sqlkit.json.`);
	}

	const stats = statSync(configPath);
	const cached = configCache.get(configPath);
	if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
		return refreshProjectConfigCacheKeys(cached.config);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(configPath, "utf-8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read ${configPath}: ${message}`);
	}

	const config = validateProjectConfigData(parsed, configPath);
	configCache.set(configPath, {
		mtimeMs: stats.mtimeMs,
		size: stats.size,
		config,
	});
	return config;
}

export function resolveSource(config: ResolvedProjectConfig, requestedSource?: string): ResolvedDataSource {
	if (requestedSource) {
		const match = config.sources.find((source) => source.name === requestedSource);
		if (!match) {
			throw new Error(`Unknown source "${requestedSource}". Call sql_list_sources to inspect available datasource names.`);
		}
		return match;
	}

	if (config.sources.length === 1) return config.sources[0];
	if (config.sources.length === 0) {
		throw new Error("No SQL sources are configured. Add a source to sqlkit.json first.");
	}

	throw new Error("Multiple datasources are configured. Call sql_list_sources first, then pass source explicitly.");
}
