import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { closeAllAdapters, getAdapter } from "../adapters/registry.js";
import { clearProjectConfigCache, validateProjectConfigData } from "./loader.js";
import { loadProjectConfigDraft, writeProjectConfigDocument } from "./store.js";
import { executeValidateConfig } from "../core/execution.js";
import { TEST_CONNECTION_TIMEOUT_MS, TEST_CONNECTION_TIMEOUT_SECONDS, formatConnectionNotice } from "./tui/connection-test.js";
import type { DialectChoice } from "./tui/dialect-picker.js";
import type { SourceListAction, SourceListItem } from "./tui/source-list.js";
import type { ResolvedDataSource } from "../types.js";
import { buildStatusText } from "../extension/context.js";
import { asBoolean, asTrimmedString, isRecord } from "../utils.js";

type SqlConfigContext = {
	cwd?: string;
	hasUI?: boolean;
	sqlkitToolsEnabled?: boolean;
	toggleSqlkitTools?: () => Promise<void> | void;
	ui: {
		select(title: string, options: string[]): Promise<string | undefined>;
		confirm(title: string, message: string): Promise<boolean>;
		input(title: string, placeholder?: string): Promise<string | undefined>;
		editor(title: string, prefill?: string): Promise<string | undefined>;
		notify(message: string, type?: "info" | "warning" | "error"): void;
		setStatus(key: string, text: string | undefined): void;
		setEditorText(text: string): void;
		custom?: <T>(factory: (...args: any[]) => any, options?: any) => Promise<T>;
	};
};

type JsonRecord = Record<string, unknown>;
type SourceRecord = JsonRecord;


function getCwd(ctx: SqlConfigContext): string {
	return ctx.cwd ?? process.cwd();
}

function ensureRootConfig(value: unknown): JsonRecord {
	return isRecord(value) ? value : { sources: [] };
}

function ensureSources(root: JsonRecord): SourceRecord[] {
	if (!Array.isArray(root.sources)) root.sources = [];
	return root.sources as SourceRecord[];
}

function ensureOptions(source: SourceRecord): JsonRecord {
	if (!isRecord(source.options)) source.options = {};
	return source.options as JsonRecord;
}

function sourceName(source: SourceRecord): string {
	return asTrimmedString(source.name) ?? "(unnamed)";
}

function sourceDialect(source: SourceRecord): "mysql" | "clickhouse" | undefined {
	const dialect = asTrimmedString(source.dialect);
	return dialect === "mysql" || dialect === "clickhouse" ? dialect : undefined;
}

function sourceLabel(source: SourceRecord): string {
	const name = sourceName(source);
	const dialect = sourceDialect(source) ?? "?";
	return `${name} (${dialect})`;
}

function displayConfigPath(cwd: string, configPath: string): string {
	const relative = path.relative(cwd, configPath) || configPath;
	return relative.replace(/\\/g, "/");
}

function asPort(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
	if (typeof value === "string") {
		const parsed = Number.parseInt(value, 10);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return fallback;
}

function parseUrlEndpoint(url: string | undefined): { host?: string; port?: number } {
	if (!url) return {};
	try {
		const parsed = new URL(url);
		const protocol = parsed.protocol.replace(/:$/, "").toLowerCase();
		return {
			host: parsed.hostname,
			port: parsed.port ? Number(parsed.port) : protocol === "https" ? 8443 : 8123,
		};
	} catch {
		return {};
	}
}

function clickHouseProtocol(source: SourceRecord): string {
	const options = ensureOptions(source);
	return asTrimmedString(options.protocol) ?? (asBoolean(options.secure, false) ? "https" : "http");
}

function sourceDatabase(source: SourceRecord): string {
	return asTrimmedString(ensureOptions(source).database) ?? "-";
}

function sourceEndpoint(source: SourceRecord): string {
	const options = ensureOptions(source);
	const dialect = sourceDialect(source);
	const socketPath = asTrimmedString(options.socketPath);
	if (dialect === "mysql" && socketPath) return socketPath;
	const url = asTrimmedString(options.url);
	if (dialect === "clickhouse" && url) return url;
	const fallbackPort = dialect === "mysql" ? 3306 : clickHouseProtocol(source).toLowerCase() === "https" ? 8443 : 8123;
	const host = asTrimmedString(options.host) ?? "127.0.0.1";
	const port = asPort(options.port, fallbackPort);
	return `${host}:${port}`;
}

function sourceListItems(root: JsonRecord): SourceListItem[] {
	return ensureSources(root).map((source) => ({
		name: sourceName(source),
		dialect: sourceDialect(source) ?? "?",
		database: sourceDatabase(source),
		endpoint: sourceEndpoint(source),
	}));
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function mysqlTemplate(): SourceRecord {
	return {
		name: "mysql_local",
		dialect: "mysql",
		read_only: true,
		allow_apply: false,
		access: {
			databases: {
				allow: [],
				deny: [],
			},
			tables: [],
		},
		options: {
			host: "127.0.0.1",
			port: 3306,
			user: "readonly_user",
			password: "",
		},
	};
}

function clickHouseTemplate(): SourceRecord {
	return {
		name: "clickhouse_local",
		dialect: "clickhouse",
		read_only: true,
		allow_apply: false,
		access: {
			databases: {
				allow: [],
				deny: [],
			},
			tables: [],
		},
		options: {
			host: "127.0.0.1",
			port: 8123,
			user: "default",
			password: "",
		},
	};
}

function newSource(dialect: "mysql" | "clickhouse"): SourceRecord {
	return clone(dialect === "mysql" ? mysqlTemplate() : clickHouseTemplate());
}

async function promptRequiredString(ctx: SqlConfigContext, title: string, current?: string): Promise<string | null> {
	while (true) {
		const response = await ctx.ui.input(title, current ?? "");
		if (response == null) return null;
		const value = response.trim();
		if (value) return value;
		if (current && current.trim()) return current.trim();
		ctx.ui.notify("Value is required.", "warning");
	}
}

async function promptOptionalString(ctx: SqlConfigContext, title: string, current?: string): Promise<string | undefined | null> {
	const response = await ctx.ui.input(title, current ?? "");
	if (response == null) return null;
	const value = response.trim();
	if (!value) return current?.trim() || undefined;
	if (value === "-") return undefined;
	return value;
}

async function promptPort(ctx: SqlConfigContext, title: string, current: number): Promise<number | null> {
	while (true) {
		const response = await ctx.ui.input(title, String(current));
		if (response == null) return null;
		const value = response.trim();
		if (!value) return current;
		const parsed = Number(value);
		if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) return parsed;
		ctx.ui.notify("Enter a valid port number between 1 and 65535.", "warning");
	}
}

async function saveConfig(ctx: SqlConfigContext, configPath: string, root: JsonRecord): Promise<void> {
	writeProjectConfigDocument(configPath, root);
	await closeAllAdapters();
	ctx.ui.setStatus("sqlkit", buildStatusText(getCwd(ctx)));
}

async function showValidationSummary(ctx: SqlConfigContext, checkConnections: boolean): Promise<void> {
	const result = await executeValidateConfig(getCwd(ctx), { check_connections: checkConnections });
	ctx.ui.notify(
		result.details.ok ? `SQL config checked (${result.details.issues.length} issue(s)).` : `SQL config has ${result.details.issues.length} issue(s).`,
		result.details.ok ? "info" : "warning",
	);
}

function sourceList(root: JsonRecord): string[] {
	return ensureSources(root).map((source) => sourceLabel(source));
}

function sourceAt(root: JsonRecord, label: string): SourceRecord | undefined {
	const labels = sourceList(root);
	const index = labels.indexOf(label);
	if (index < 0) return undefined;
	return ensureSources(root)[index];
}

async function selectSource(ctx: SqlConfigContext, root: JsonRecord, title: string): Promise<SourceRecord | undefined> {
	const choice = await ctx.ui.select(title, sourceList(root));
	if (!choice) return undefined;
	return sourceAt(root, choice);
}

type AddSourceField = { key: string; label: string; value: string; required: boolean; hint?: string; placeholder?: string };

function addSourceFields(dialect: "mysql" | "clickhouse", template: SourceRecord): AddSourceField[] {
	const options = ensureOptions(template);
	if (dialect === "mysql") {
		const port = options.port ?? 3306;
		return [
			{ key: "host", label: "Host", value: "", placeholder: asTrimmedString(options.host) ?? "127.0.0.1", required: true, hint: "Database host or IP address" },
			{ key: "port", label: "Port", value: String(port), required: true, hint: "MySQL TCP port" },
			{ key: "user", label: "User", value: "", placeholder: asTrimmedString(options.user) ?? "readonly_user", required: true, hint: "Use a restricted read-only account when possible" },
			{ key: "password", label: "Password", value: "", placeholder: asTrimmedString(options.password) ?? "", required: true, hint: "MySQL password is required" },
			{ key: "name", label: "Name", value: "", required: false, hint: "Auto-generated from Host:Port if left empty" },
			{ key: "database", label: "Database", value: "", required: false, hint: "Optional connection database" },
		];
	}
	const port = options.port ?? 8123;
	return [
		{ key: "host", label: "Host", value: "", placeholder: asTrimmedString(options.host) ?? "127.0.0.1", required: true, hint: "ClickHouse host or IP address" },
		{ key: "port", label: "Port", value: String(port), required: true, hint: "ClickHouse HTTP port" },
		{ key: "user", label: "User", value: "", placeholder: asTrimmedString(options.user) ?? "default", required: true, hint: "ClickHouse user for this datasource" },
		{ key: "password", label: "Password", value: "", placeholder: asTrimmedString(options.password) ?? "", required: false, hint: "Leave blank if no password is required" },
		{ key: "name", label: "Name", value: "", required: false, hint: "Auto-generated from Host:Port if left empty" },
		{ key: "database", label: "Database", value: "", required: false, hint: "Optional connection database" },
	];
}

function formFieldValue(field: AddSourceField): string {
	return field.value.trim() || field.placeholder?.trim() || "";
}

function fieldValues(fields: AddSourceField[]): Record<string, string> {
	const values: Record<string, string> = {};
	for (const field of fields) values[field.key] = formFieldValue(field);
	return values;
}

function applyFormValuesToSource(source: SourceRecord, fields: AddSourceField[], dialect: "mysql" | "clickhouse"): SourceRecord {
	const values = fieldValues(fields);
	const options = ensureOptions(source);

	if (dialect === "mysql") {
		if (values.host) {
			options.host = values.host;
			delete options.socketPath;
		}
		const port = Number(values.port);
		if (Number.isInteger(port) && port > 0) { options.port = port; }
		if (values.user) options.user = values.user;
		if (values.database) {
			options.database = values.database;
		} else {
			delete options.database;
		}
		if (!values.name) source.name = `${options.host ?? "127.0.0.1"}:${options.port ?? 3306}`;
		else source.name = values.name;
		if (values.password) options.password = values.password;
		else delete options.password;
	}

	if (dialect === "clickhouse") {
		delete options.url;
		if (values.host) options.host = values.host;
		const port = Number(values.port);
		if (Number.isInteger(port) && port > 0) { options.port = port; }
		if (values.user) {
			options.user = values.user;
			delete options.username;
		}
		if (values.database) {
			options.database = values.database;
		} else {
			delete options.database;
		}
		if (!values.name) source.name = `${options.host ?? "127.0.0.1"}:${options.port ?? 8123}`;
		else source.name = values.name;
		if (values.password) options.password = values.password;
		else delete options.password;
	}

	return source;
}

export function formResultToSource(fields: AddSourceField[], dialect: "mysql" | "clickhouse"): SourceRecord {
	return applyFormValuesToSource(newSource(dialect), fields, dialect);
}

function editSourceFields(dialect: "mysql" | "clickhouse", source: SourceRecord): AddSourceField[] {
	const options = ensureOptions(source);
	const fields = addSourceFields(dialect, source);
	const urlEndpoint = dialect === "clickhouse" ? parseUrlEndpoint(asTrimmedString(options.url)) : {};
	for (const field of fields) {
		if (field.key === "name") field.value = sourceName(source);
		if (field.key === "database") field.value = sourceDatabase(source) === "-" ? "" : sourceDatabase(source);
		if (field.key === "host") field.value = asTrimmedString(options.host) ?? urlEndpoint.host ?? "";
		if (field.key === "port") field.value = String(asPort(options.port, urlEndpoint.port ?? (dialect === "mysql" ? 3306 : clickHouseProtocol(source).toLowerCase() === "https" ? 8443 : 8123)));
		if (field.key === "user") field.value = asTrimmedString(options.user) ?? asTrimmedString(options.username) ?? "";
		if (field.key === "password") field.value = typeof options.password === "string" ? options.password : "";
	}
	return fields;
}

async function promptAddSourceSequential(ctx: SqlConfigContext, source: SourceRecord, existingNames: Set<string>): Promise<SourceRecord | null> {
	if (sourceDialect(source) === "mysql") {
		const options = ensureOptions(source);
		const host = await promptRequiredString(ctx, "MySQL host", asTrimmedString(options.host) ?? "127.0.0.1");
		if (host == null) return null;
		const port = await promptPort(ctx, "MySQL port", Number(options.port ?? 3306));
		if (port == null) return null;
		const user = await promptRequiredString(ctx, "MySQL user", asTrimmedString(options.user) ?? "readonly_user");
		if (user == null) return null;
		const nameDefault = `${host}:${port}`;
		const name = await promptOptionalString(ctx, `Name (defaults to ${nameDefault})`, sourceName(source));
		if (name === null) return null;
		const database = await promptOptionalString(ctx, "Database (optional)", asTrimmedString(options.database) ?? "");
		if (database === null) return null;
		const password = await promptOptionalString(ctx, "Password (leave blank if none)", asTrimmedString(options.password));
		if (password === null) return null;

		options.host = host;
		options.port = port;
		options.user = user;
		if (database) {
			options.database = database;
		} else {
			delete options.database;
		}
		source.name = name || nameDefault;
		if (password) options.password = password;
		else delete options.password;
	}

	if (sourceDialect(source) === "clickhouse") {
		const options = ensureOptions(source);
		const host = await promptRequiredString(ctx, "ClickHouse host", asTrimmedString(options.host) ?? "127.0.0.1");
		if (host == null) return null;
		const port = await promptPort(ctx, "ClickHouse port", Number(options.port ?? 8123));
		if (port == null) return null;
		const user = await promptRequiredString(ctx, "ClickHouse user", asTrimmedString(options.user) ?? "default");
		if (user == null) return null;
		const nameDefault = `${host}:${port}`;
		const name = await promptOptionalString(ctx, `Name (defaults to ${nameDefault})`, sourceName(source));
		if (name === null) return null;
		const database = await promptOptionalString(ctx, "Database (optional)", asTrimmedString(options.database) ?? "");
		if (database === null) return null;
		const password = await promptOptionalString(ctx, "Password (leave blank if none)", asTrimmedString(options.password));
		if (password === null) return null;

		delete options.url;
		options.host = host;
		options.port = port;
		options.user = user;
		if (database) {
			options.database = database;
		} else {
			delete options.database;
		}
		source.name = name || nameDefault;
		if (password) options.password = password;
		else delete options.password;
	}

	return source;
}

async function showAddSourceForm(ctx: SqlConfigContext, dialect: "mysql" | "clickhouse", existingNames: Set<string>): Promise<SourceRecord | null> {
	try {
		const { showSourceForm } = await import("./tui/form.js");
		const fields = addSourceFields(dialect, newSource(dialect));
		const result = await showSourceForm(ctx, dialect, fields, existingNames, async (currentFields) => {
			return testConnectionFromFields(dialect, currentFields);
		});
		if (result == null) return null;
		return formResultToSource(result, dialect);
	} catch {
		return null;
	}
}

async function pingSourceForUi(source: SourceRecord, dialect: "mysql" | "clickhouse"): Promise<string> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), TEST_CONNECTION_TIMEOUT_MS);
	try {
		const testSource = clone(source);
		const options = ensureOptions(testSource);
		delete options.database;
		options.connect_timeout_ms = TEST_CONNECTION_TIMEOUT_MS;
		options.query_timeout_ms = TEST_CONNECTION_TIMEOUT_MS;
		options.request_timeout_ms = TEST_CONNECTION_TIMEOUT_MS;
		options.send_receive_timeout = TEST_CONNECTION_TIMEOUT_MS / 1000;
		const adapter = await getAdapter(dialect);
		const ping = await adapter.ping(resolveTestSource(testSource, dialect), controller.signal);
		const db = ping.current_database ? ` / ${ping.current_database}` : "";
		return `Connected: ${ping.server_version ?? dialect}${db}`;
	} catch (error) {
		if (controller.signal.aborted) return `Timed out after ${TEST_CONNECTION_TIMEOUT_SECONDS}s`;
		return error instanceof Error ? error.message : String(error);
	} finally {
		clearTimeout(timeout);
	}
}

// Build a ResolvedDataSource for a connection test. The cacheKey signs the
// connection params so that editing host/user/password between test attempts
// produces a fresh pool/client: the adapter's stale-cache cleanup keys on
// (configPath, name, dialect) and closes the previous pool when cacheKey
// changes. The synthetic configPath "__test__" keeps test pools isolated from
// real resolved sources. Password is included in the key directly — it is an
// in-memory Map string and the password already lives in options alongside it.
function resolveTestSource(source: SourceRecord, dialect: DialectChoice): ResolvedDataSource {
	const name = asTrimmedString(source.name) ?? "__test__";
	const options = ensureOptions(source);
	const signature = JSON.stringify({ dialect, name, options });
	return {
		name,
		dialect,
		readOnly: true,
		allowApply: false,
		access: { databases: { allow: [], deny: [] }, tables: [] },
		options,
		configPath: "__test__",
		cacheKey: `__test__:${signature}`,
	};
}

async function testConnectionFromFields(dialect: "mysql" | "clickhouse", fields: AddSourceField[], baseSource?: SourceRecord): Promise<string> {
	const source = baseSource ? applyFormValuesToSource(clone(baseSource), fields, dialect) : formResultToSource(fields, dialect);
	return pingSourceForUi(source, dialect);
}

async function chooseSourceDialect(ctx: SqlConfigContext): Promise<DialectChoice | undefined> {
	const dialects: DialectChoice[] = ["mysql", "clickhouse"];
	if (ctx.ui.custom) {
		const { showDialectPicker } = await import("./tui/dialect-picker.js");
		return showDialectPicker(ctx, dialects);
	}
	const choice = await ctx.ui.select("Select datasource dialect", dialects);
	return choice === "mysql" || choice === "clickhouse" ? choice : undefined;
}

async function addSource(ctx: SqlConfigContext, root: JsonRecord, configPath: string): Promise<void> {
	const sources = ensureSources(root);
	const dialect = await chooseSourceDialect(ctx);
	if (!dialect) return;

	const existingNames = new Set(sources.map((item) => sourceName(item)));

	let source: SourceRecord | null;
	if (ctx.ui.custom) {
		source = await showAddSourceForm(ctx, dialect, existingNames);
	} else {
		const template = newSource(dialect);
		source = await promptAddSourceSequential(ctx, template, existingNames);
	}

	if (!source) return;

	const existingIndex = sources.findIndex((item) => sourceName(item) === sourceName(source));
	if (existingIndex >= 0) {
		sources[existingIndex] = source;
	} else {
		sources.push(source);
	}
	await saveConfig(ctx, configPath, root);
	await showValidationSummary(ctx, false);
	ctx.ui.notify(`Saved source "${sourceName(source)}".`, "info");
}

async function editSourceWithForm(ctx: SqlConfigContext, root: JsonRecord, configPath: string, index: number): Promise<void> {
	const sources = ensureSources(root);
	const source = sources[index];
	if (!source) return;
	const dialect = sourceDialect(source);
	if (!dialect) {
		ctx.ui.notify(`Source "${sourceName(source)}" has an unsupported dialect.`, "error");
		return;
	}
	const oldName = sourceName(source);
	const existingNames = new Set(sources.map((item) => sourceName(item)));
	existingNames.delete(oldName);
	const { showSourceForm } = await import("./tui/form.js");
	const fields = editSourceFields(dialect, source);
	const result = await showSourceForm(ctx, dialect, fields, existingNames, async (currentFields) => {
		return testConnectionFromFields(dialect, currentFields, source);
	}, { title: `${dialect === "mysql" ? "Edit MySQL Source" : "Edit ClickHouse Source"}`, note: oldName });
	if (result == null) return;

	const updated = applyFormValuesToSource(clone(source), result, dialect);
	const nextName = sourceName(updated);
	if (existingNames.has(nextName)) {
		ctx.ui.notify(`Source name "${nextName}" already exists.`, "error");
		return;
	}
	sources[index] = updated;
	await saveConfig(ctx, configPath, root);
	await showValidationSummary(ctx, false);
	ctx.ui.notify(`Updated source "${nextName}".`, "info");
}

async function editSource(ctx: SqlConfigContext, root: JsonRecord, configPath: string): Promise<void> {
	const source = await selectSource(ctx, root, "Edit source");
	if (!source) return;

	const oldName = sourceName(source);
	while (true) {
		const field = await ctx.ui.select(
			`Edit ${oldName}`,
			sourceDialect(source) === "mysql"
				? ["name", "database", "host", "port", "user", "password", "done"]
				: ["name", "database", "host", "port", "user", "password", "done"],
		);
		if (!field || field === "done") break;

		if (field === "name") {
			const allNames = new Set(ensureSources(root).map((item) => sourceName(item)));
			allNames.delete(oldName);
			const nextName = await promptRequiredString(ctx, "Source name", oldName);
			if (nextName == null) return;
			if (allNames.has(nextName)) {
				ctx.ui.notify(`Source name "${nextName}" already exists.`, "error");
				continue;
			}
			source.name = nextName;
			continue;
		}

		if (field === "database") {
			const options = ensureOptions(source);
			const currentDatabase = asTrimmedString(options.database);
			const nextDatabase = await promptOptionalString(ctx, "Database (use - to clear)", currentDatabase);
			if (nextDatabase === null) return;
			if (nextDatabase === undefined) delete options.database;
			else options.database = nextDatabase;
			continue;
		}

		if (field === "password") {
			const options = ensureOptions(source);
			const nextPassword = await promptOptionalString(ctx, "Password (use - to clear)", asTrimmedString(options.password));
			if (nextPassword === null) return;
			if (nextPassword === undefined) delete options.password;
			else options.password = nextPassword;
			continue;
		}

		if (field === "host" && sourceDialect(source) === "mysql") {
			const options = ensureOptions(source);
			const nextHost = await promptRequiredString(ctx, "MySQL host", asTrimmedString(options.host));
			if (nextHost == null) return;
			options.host = nextHost;
			continue;
		}

		if (field === "port" && sourceDialect(source) === "mysql") {
			const options = ensureOptions(source);
			const nextPort = await promptPort(ctx, "MySQL port", Number(options.port ?? 3306));
			if (nextPort == null) return;
			options.port = nextPort;
			continue;
		}

		if (field === "user" && sourceDialect(source) === "mysql") {
			const options = ensureOptions(source);
			const nextUser = await promptRequiredString(ctx, "MySQL user", asTrimmedString(options.user));
			if (nextUser == null) return;
			options.user = nextUser;
			continue;
		}

		if (field === "host" && sourceDialect(source) === "clickhouse") {
			const options = ensureOptions(source);
			const nextHost = await promptRequiredString(ctx, "ClickHouse host", asTrimmedString(options.host));
			if (nextHost == null) return;
			delete options.url;
			options.host = nextHost;
			continue;
		}

		if (field === "port" && sourceDialect(source) === "clickhouse") {
			const options = ensureOptions(source);
			const nextPort = await promptPort(ctx, "ClickHouse port", Number(options.port ?? 8123));
			if (nextPort == null) return;
			delete options.url;
			options.port = nextPort;
			continue;
		}

		if (field === "user" && sourceDialect(source) === "clickhouse") {
			const options = ensureOptions(source);
			const nextUser = await promptRequiredString(ctx, "ClickHouse user", asTrimmedString(options.user));
			if (nextUser == null) return;
			options.user = nextUser;
			continue;
		}
	}

	await saveConfig(ctx, configPath, root);
	await showValidationSummary(ctx, false);
	ctx.ui.notify(`Updated source "${sourceName(source)}".`, "info");
}

async function testSourceAt(root: JsonRecord, index: number): Promise<string> {
	const source = ensureSources(root)[index];
	if (!source) return "Source was not found.";
	const dialect = sourceDialect(source);
	if (!dialect) return `Source "${sourceName(source)}" has an unsupported dialect.`;
	const result = await pingSourceForUi(source, dialect);
	const notice = formatConnectionNotice(result);
	return `${sourceName(source)}: ${notice.message}`;
}

async function deleteSourceAt(ctx: SqlConfigContext, root: JsonRecord, configPath: string, index: number): Promise<boolean> {
	const sources = ensureSources(root);
	const source = sources[index];
	if (!source) return false;
	const name = sourceName(source);
	let confirmed: boolean;
	if (ctx.ui.custom) {
		const { showDeleteConfirm } = await import("./tui/confirm.js");
		confirmed = await showDeleteConfirm(ctx, name);
	} else {
		confirmed = await ctx.ui.confirm("Delete source", `Delete source "${name}"?`);
	}
	if (!confirmed) return false;

	sources.splice(index, 1);
	if (sources.length === 0) {
		if (existsSync(configPath)) rmSync(configPath, { force: true });
		clearProjectConfigCache();
		await closeAllAdapters();
		ctx.ui.setStatus("sqlkit", buildStatusText(getCwd(ctx)));
		ctx.ui.notify(`Deleted source "${name}".`, "info");
		return true;
	}

	await saveConfig(ctx, configPath, root);
	ctx.ui.notify(`Deleted source "${name}".`, "info");
	return true;
}

async function advancedJson(ctx: SqlConfigContext, configPath: string, currentText: string): Promise<void> {
	const edited = await ctx.ui.editor("Edit SQL config JSON", currentText);
	if (edited == null) return;

	let parsed: unknown;
	try {
		parsed = JSON.parse(edited);
	} catch (error) {
		ctx.ui.notify(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}

	try {
		validateProjectConfigData(parsed, configPath);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return;
	}

	writeProjectConfigDocument(configPath, parsed);
	await closeAllAdapters();
	ctx.ui.setStatus("sqlkit", buildStatusText(getCwd(ctx)));
	await showValidationSummary(ctx, false);
	ctx.ui.notify("SQL config saved from advanced editor.", "info");
}

export async function openSqlConfig(ctx: unknown): Promise<void> {
	if (!isRecord(ctx) || !isRecord(ctx.ui)) {
		throw new Error("Invalid SQL config context.");
	}
	const uiCtx = ctx as SqlConfigContext;
	if (uiCtx.hasUI === false) {
		uiCtx.ui.notify("/sqlkit requires interactive or RPC UI.", "error");
		return;
	}

	const draft = loadProjectConfigDraft(getCwd(uiCtx));
	const configPath = draft.configPath;
	let root = ensureRootConfig(draft.rawObject ?? { sources: [] });

	if (draft.parseError) {
		uiCtx.ui.notify(`SQL config JSON is invalid: ${draft.parseError}`, "warning");
		return;
	}

	while (true) {
		ensureSources(root);
		const hasSources = ensureSources(root).length > 0;
		const title = displayConfigPath(getCwd(uiCtx), configPath);

		if (uiCtx.ui.custom) {
			const { showSourceList } = await import("./tui/source-list.js");
			const action: SourceListAction = await showSourceList(uiCtx, title, sourceListItems(root), {
				toolsEnabled: uiCtx.sqlkitToolsEnabled === true,
				onTestConnection: (index) => testSourceAt(root, index),
			});
			if (!action) return;
			if (action.type === "add") {
				await addSource(uiCtx, root, configPath);
				draft.exists = true;
				continue;
			}
			if (action.type === "edit") {
				await editSourceWithForm(uiCtx, root, configPath, action.index);
				continue;
			}
			if (action.type === "delete") {
				const deleted = await deleteSourceAt(uiCtx, root, configPath, action.index);
				if (deleted && ensureSources(root).length === 0) draft.exists = false;
				continue;
			}
			if (action.type === "toggle-tools") {
				await uiCtx.toggleSqlkitTools?.();
				continue;
			}
			continue;
		}

		const actions = hasSources
			? ["Add source", "Edit source", "Cancel"]
			: ["Add source", "Cancel"];
		const action = await uiCtx.ui.select(draft.exists ? `SQL Config (${configPath})` : `SQL Config (new file: ${configPath})`, actions);
		if (!action || action === "Cancel") return;

		if (action === "Add source") {
			await addSource(uiCtx, root, configPath);
			draft.exists = true;
			continue;
		}

		if (action === "Edit source") {
			await editSource(uiCtx, root, configPath);
			continue;
		}
	}
}
