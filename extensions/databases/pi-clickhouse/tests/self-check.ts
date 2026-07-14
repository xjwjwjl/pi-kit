import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __test__ } from "../index.ts";

function testResolveProjectConfig() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-clickhouse-self-check-"));
	fs.mkdirSync(path.join(dir, ".pi"));
	fs.writeFileSync(
		path.join(dir, ".pi", "databases.json"),
		JSON.stringify({
			clickhouse: {
				host: "localhost",
				port: 8123,
				secure: false,
				username: "default",
				password: "secret",
				database: "default",
				allow_write_access: false,
			},
		}),
		"utf-8",
	);

	const resolved = __test__.resolveProjectConfig(dir);
	assert.equal(resolved.sourcePath, path.join(dir, ".pi", "databases.json"));
	assert.equal(resolved.url, "http://localhost:8123");
	assert.equal(resolved.username, "default");
	assert.equal(resolved.database, "default");
	assert.equal(resolved.allowWriteAccess, false);
}

function testLegacyConfigIsIgnored() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-clickhouse-self-check-"));
	fs.mkdirSync(path.join(dir, ".pi"));
	fs.writeFileSync(
		path.join(dir, ".pi", "clickhouse.json"),
		JSON.stringify({ host: "localhost", username: "default" }),
		"utf-8",
	);
	assert.throws(() => __test__.resolveProjectConfig(dir), /No ClickHouse config found/);
}

function testReadAndWriteGuards() {
	const writeConfig = { allowWriteAccess: true };
	const disabledConfig = { allowWriteAccess: false };
	assert.doesNotThrow(() => __test__.validateReadQuerySafety("SELECT 1"));
	assert.throws(() => __test__.validateReadQuerySafety("INSERT INTO events VALUES (1)"), /supports only/);
	assert.equal(__test__.hasMultipleStatements("SELECT ';'"), false);
	assert.equal(__test__.hasMultipleStatements("SELECT 1; SELECT 2"), true);

	assert.doesNotThrow(() => __test__.validateWriteStatement(writeConfig as never, "INSERT INTO analytics.events (id) VALUES (1)"));
	assert.doesNotThrow(() => __test__.validateWriteStatement(writeConfig as never, "CREATE TABLE analytics.events_copy (id UInt64)"));
	assert.doesNotThrow(() => __test__.validateWriteStatement(writeConfig as never, "ALTER TABLE analytics.events ADD COLUMN name String"));
	assert.throws(() => __test__.validateWriteStatement(disabledConfig as never, "INSERT INTO analytics.events (id) VALUES (1)"), /writes are disabled/);
	assert.throws(() => __test__.validateWriteStatement(writeConfig as never, "INSERT INTO analytics.events SELECT id FROM analytics.other_events"), /supports only/);
	assert.throws(() => __test__.validateWriteStatement(writeConfig as never, "CREATE TABLE analytics.events_copy (id UInt64) AS SELECT id FROM analytics.events"), /derived CREATE TABLE/);
	assert.throws(() => __test__.validateWriteStatement(writeConfig as never, "CREATE TABLE analytics.events_copy ON CLUSTER cluster_a (id UInt64)"), /ON CLUSTER/);
	assert.throws(() => __test__.validateWriteStatement(writeConfig as never, "ALTER TABLE analytics.events DELETE WHERE id = 1"), /destructive or mutation/);
	assert.throws(() => __test__.validateWriteStatement(writeConfig as never, "DROP TABLE analytics.events"), /destructive or administrative/);
	assert.throws(() => __test__.validateWriteStatement(writeConfig as never, "INSERT INTO analytics.events (id) VALUES (1); DROP TABLE analytics.events"), /single SQL statement/);
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
		"clickhouse_ping",
		"clickhouse_list_databases",
		"clickhouse_list_tables",
		"clickhouse_run_query",
		"clickhouse_write",
	]);
}

testResolveProjectConfig();
testLegacyConfigIsIgnored();
testReadAndWriteGuards();
testToolRegistration();
console.log("pi-clickhouse self-check OK");
