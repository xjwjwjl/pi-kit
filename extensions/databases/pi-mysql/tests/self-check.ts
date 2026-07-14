import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __test__ } from "../index.ts";

function testNormalizeQuery() {
	assert.equal(__test__.normalizeQueryForMysqlClient("SELECT 1;   \n"), "SELECT 1");
	assert.equal(__test__.normalizeQueryForMysqlClient("SELECT 1 -- hi"), "SELECT 1");
}

function testMultipleStatements() {
	assert.equal(__test__.hasMultipleStatements("SELECT 1"), false);
	assert.equal(__test__.hasMultipleStatements("SELECT ';'"), false);
	assert.equal(__test__.hasMultipleStatements("SELECT 1; SELECT 2"), true);
	assert.equal(__test__.hasMultipleStatements("SELECT 1 /* hi */ ; DELETE FROM t"), true);
}

function testExecutableCommentsAndStatementKeyword() {
	assert.equal(__test__.containsMysqlExecutableComment("SELECT 1"), false);
	assert.equal(__test__.containsMysqlExecutableComment("SELECT /*!40101 SQL_NO_CACHE */ 1"), true);
	assert.equal(__test__.getStatementKeyword("WITH x AS (SELECT 1) SELECT * FROM x"), "SELECT");
	assert.equal(__test__.getStatementKeyword("WITH x AS (SELECT 1) DELETE FROM users"), "DELETE");
	assert.equal(__test__.isQueryWithOutput("WITH x AS (SELECT 1) SELECT * FROM x"), true);
	assert.equal(__test__.isQueryWithOutput("WITH x AS (SELECT 1) DELETE FROM users"), false);
}

function testReadOnlyGuard() {
	assert.doesNotThrow(() => __test__.validateReadQuerySafety("SELECT 1"));
	assert.doesNotThrow(() => __test__.validateReadQuerySafety("SHOW TABLES"));
	assert.throws(() => __test__.validateReadQuerySafety("UPDATE users SET name = 'a'"), /supports only/);
	assert.throws(() => __test__.validateReadQuerySafety("WITH x AS (SELECT 1) DELETE FROM users"), /supports only/);
	assert.throws(() => __test__.validateReadQuerySafety("SELECT * FROM users FOR UPDATE"), /blocked MySQL clause/);
	assert.throws(() => __test__.validateReadQuerySafety("SELECT 1 INTO OUTFILE '/tmp/a'"), /blocked MySQL clause|file operation/);
	assert.throws(() => __test__.validateReadQuerySafety("SELECT /*!40101 SQL_NO_CACHE */ 1"), /executable comments/);
}

function testWriteGuard() {
	const writeConfig = { allowWriteAccess: true };
	const disabledConfig = { allowWriteAccess: false };
	assert.doesNotThrow(() => __test__.validateWriteStatement(writeConfig as never, "INSERT INTO users (id) VALUES (1)"));
	assert.doesNotThrow(() => __test__.validateWriteStatement(writeConfig as never, "UPDATE users SET name = 'a' WHERE id = 1"));
	assert.doesNotThrow(() => __test__.validateWriteStatement(writeConfig as never, "CREATE TABLE audit_log (id bigint)"));
	assert.doesNotThrow(() => __test__.validateWriteStatement(writeConfig as never, "ALTER TABLE users ADD COLUMN nickname varchar(32)"));
	assert.throws(() => __test__.validateWriteStatement(disabledConfig as never, "INSERT INTO users (id) VALUES (1)"), /writes are disabled/);
	assert.throws(() => __test__.validateWriteStatement(writeConfig as never, "UPDATE users SET name = 'a'"), /WHERE clause/);
	assert.throws(() => __test__.validateWriteStatement(writeConfig as never, "UPDATE users JOIN teams ON teams.id = users.team_id SET users.name = 'a' WHERE teams.id = 1"), /supports only/);
	assert.throws(() => __test__.validateWriteStatement(writeConfig as never, "INSERT INTO users (id) SELECT id FROM archived_users"), /supports only/);
	assert.throws(() => __test__.validateWriteStatement(writeConfig as never, "CREATE TABLE copied_users AS SELECT * FROM users"), /supports only/);
	assert.throws(() => __test__.validateWriteStatement(writeConfig as never, "CREATE TABLE copied_users (id bigint) AS SELECT id FROM users"), /derived CREATE TABLE/);
	assert.throws(() => __test__.validateWriteStatement(writeConfig as never, "DELETE FROM users WHERE id = 1"), /does not support DELETE/);
	assert.throws(() => __test__.validateWriteStatement(writeConfig as never, "DROP TABLE users"), /does not support DROP/);
	assert.throws(() => __test__.validateWriteStatement(writeConfig as never, "INSERT INTO users (id) VALUES (1); DELETE FROM users"), /single SQL statement/);
}

function testFormatSql() {
	const formatted = __test__.formatSqlForUi("SELECT a, b FROM users WHERE id = 1 ORDER BY id LIMIT 1");
	assert.match(formatted, /^SELECT\n  a,\n  b\nFROM users\nWHERE id = 1\nORDER BY id\nLIMIT 1$/);
}

function testResolveProjectConfig() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mysql-self-check-"));
	fs.mkdirSync(path.join(dir, ".pi"));
	fs.writeFileSync(
		path.join(dir, ".pi", "databases.json"),
		JSON.stringify({
			mysql: {
				host: "127.0.0.1",
				port: 3306,
				user: "readonly_user",
				password: "secret",
				database: "app_db",
				allow_write_access: false,
			},
		}),
		"utf-8",
	);
	const resolved = __test__.resolveProjectConfig(dir);
	assert.equal(resolved.sourcePath, path.join(dir, ".pi", "databases.json"));
	assert.equal(resolved.host, "127.0.0.1");
	assert.equal(resolved.port, 3306);
	assert.equal(resolved.user, "readonly_user");
	assert.equal(resolved.database, "app_db");
	assert.equal(resolved.allowWriteAccess, false);
}

function testLegacyConfigIsIgnored() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mysql-self-check-"));
	fs.mkdirSync(path.join(dir, ".pi"));
	fs.writeFileSync(
		path.join(dir, ".pi", "mysql.json"),
		JSON.stringify({ host: "127.0.0.1", user: "readonly_user" }),
		"utf-8",
	);
	assert.throws(() => __test__.resolveProjectConfig(dir), /No MySQL config found/);
}

function testInitializeDatabaseConfig() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-init-"));
	const created = __test__.initializeDatabaseConfig(dir);
	assert.equal(created.created, true);
	assert.equal(created.configPath, path.join(dir, ".pi", "databases.json"));
	const config = JSON.parse(fs.readFileSync(created.configPath, "utf-8"));
	assert.equal(config.mysql.allow_write_access, false);
	assert.equal(config.clickhouse.allow_write_access, false);
	assert.equal(__test__.initializeDatabaseConfig(dir).created, false);

	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-init-parent-"));
	const child = path.join(parent, "child");
	fs.mkdirSync(path.join(parent, ".pi"));
	fs.mkdirSync(child);
	const inheritedPath = path.join(parent, ".pi", "databases.json");
	fs.writeFileSync(inheritedPath, "{}", "utf-8");
	const inherited = __test__.initializeDatabaseConfig(child);
	assert.equal(inherited.created, false);
	assert.equal(inherited.configPath, inheritedPath);
	assert.equal(fs.existsSync(path.join(child, ".pi", "databases.json")), false);
}

function testCommandRegistration() {
	const commands: string[] = [];
	const api = {
		registerCommand(name: string) {
			commands.push(name);
		},
	};
	__test__.registerCommands(api as never);
	assert.deepEqual(commands, ["database-init"]);
}

function testToolRegistration() {
	const tools: string[] = [];
	const api = {
		registerTool(definition: { name?: string }) {
			if (definition?.name) tools.push(definition.name);
		},
		on() {},
	};
	__test__.registerTools(api as never);
	assert.deepEqual(tools, [
		"mysql_ping",
		"mysql_list_databases",
		"mysql_list_tables",
		"mysql_run_query",
		"mysql_write",
	]);
}

function run() {
	testNormalizeQuery();
	testMultipleStatements();
	testExecutableCommentsAndStatementKeyword();
	testReadOnlyGuard();
	testWriteGuard();
	testFormatSql();
	testResolveProjectConfig();
	testLegacyConfigIsIgnored();
	testInitializeDatabaseConfig();
	testCommandRegistration();
	testToolRegistration();
	console.log("pi-mysql self-check OK");
}

run();
