import type { DialectAdapter, SqlDialect } from "../types.js";

let mysqlModule: Promise<typeof import("./mysql.js")> | undefined;
let clickhouseModule: Promise<typeof import("./clickhouse.js")> | undefined;

function loadMysqlModule() {
	mysqlModule ??= import("./mysql.js");
	return mysqlModule;
}

function loadClickhouseModule() {
	clickhouseModule ??= import("./clickhouse.js");
	return clickhouseModule;
}

export async function getAdapter(dialect: SqlDialect): Promise<DialectAdapter> {
	if (dialect === "mysql") return (await loadMysqlModule()).mysqlAdapter;
	return (await loadClickhouseModule()).clickhouseAdapter;
}

export async function closeAllAdapters(): Promise<void> {
	const closeTasks: Promise<void>[] = [];
	if (mysqlModule) closeTasks.push(loadMysqlModule().then((module) => module.closeMysqlPools()));
	if (clickhouseModule) closeTasks.push(loadClickhouseModule().then((module) => module.closeClickHouseClients()));
	await Promise.all(closeTasks);
}
