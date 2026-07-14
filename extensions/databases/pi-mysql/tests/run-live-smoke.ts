import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";

const configPath = path.join(import.meta.dirname, "mysql.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
	host: string;
	port?: number;
	user: string;
	password?: string;
	database?: string;
};

async function main() {
	const pool = mysql.createPool({
		host: config.host,
		port: config.port ?? 3306,
		user: config.user,
		password: config.password ?? "",
		database: config.database || undefined,
		waitForConnections: true,
		connectionLimit: 1,
		queueLimit: 0,
		multipleStatements: false,
		dateStrings: true,
		connectTimeout: 10_000,
	});

	try {
		const [rows] = await pool.query<mysql.RowDataPacket[]>(
			"SELECT VERSION() AS server_version, DATABASE() AS current_database, CURRENT_USER() AS current_user_name",
		);
		assert.ok(Array.isArray(rows));
		const row = rows[0] ?? {};
		console.log(JSON.stringify({
			ok: true,
			server_version: row.server_version ?? null,
			current_database: row.current_database ?? null,
			current_user: row.current_user_name ?? null,
		}, null, 2));
	} finally {
		await pool.end();
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
