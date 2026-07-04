import type { CapabilityCheckResult, CapabilityFinding, ResolvedDataSource } from "../types.js";

const MYSQL_RISKY_PRIVILEGES = [
	"INSERT",
	"UPDATE",
	"DELETE",
	"CREATE",
	"DROP",
	"ALTER",
	"TRIGGER",
	"CREATE USER",
	"SUPER",
	"FILE",
	"PROCESS",
	"SHUTDOWN",
	"RELOAD",
	"EVENT",
	"CREATE ROUTINE",
	"ALTER ROUTINE",
	"CREATE VIEW",
	"CREATE TABLESPACE",
	"REPLICATION SLAVE",
	"REPLICATION CLIENT",
	"GRANT OPTION",
];

const CLICKHOUSE_RISKY_PRIVILEGES = [
	"WRITE",
	"INSERT",
	"ALTER",
	"CREATE",
	"DROP",
	"TRUNCATE",
	"OPTIMIZE",
	"BACKUP",
	"KILL QUERY",
	"KILL TRANSACTION",
	"ROLE ADMIN",
	"CREATE USER",
	"ALTER USER",
	"DROP USER",
	"CREATE ROLE",
	"ALTER ROLE",
	"DROP ROLE",
	"SYSTEM",
	"INTROSPECTION",
	"FILE",
	"URL",
	"REMOTE",
	"MYSQL",
	"POSTGRES",
	"ODBC",
	"JDBC",
	"S3",
	"HDFS",
];

function makeFinding(
	severity: CapabilityFinding["severity"],
	code: string,
	message: string,
): CapabilityFinding {
	return { severity, code, message };
}

function hasPrivilege(privileges: string[], wanted: string): boolean {
	return privileges.some((privilege) => privilege.toUpperCase() === wanted.toUpperCase());
}

function summarizeRiskyPrivileges(
	privileges: string[],
	riskyList: string[],
	dialect: "mysql" | "clickhouse",
): CapabilityFinding[] {
	const risky = riskyList.filter((privilege) => hasPrivilege(privileges, privilege));
	if (risky.length === 0) return [];
	const preview = risky.slice(0, 8).join(", ");
	const more = risky.length > 8 ? ` (+${risky.length - 8} more)` : "";
	return [
		makeFinding(
			"warning",
			`${dialect}_risky_privileges`,
			`Account has elevated ${dialect} privileges that exceed a read-only profile: ${preview}${more}.`,
		),
	];
}

export function extractMysqlPrivilegesFromGrantStrings(grants: string[]): string[] {
	const privileges = new Set<string>();
	for (const grant of grants) {
		const normalized = grant.trim();
		if (!/^GRANT\s+/i.test(normalized)) continue;
		if (/WITH\s+GRANT\s+OPTION/i.test(normalized)) {
			privileges.add("GRANT OPTION");
		}
		const onIndex = normalized.toUpperCase().indexOf(" ON ");
		if (onIndex === -1) continue;
		const privilegePart = normalized.slice(6, onIndex).trim();
		if (privilegePart.toUpperCase() === "ALL PRIVILEGES") {
			privileges.add("ALL PRIVILEGES");
			continue;
		}
		for (const raw of privilegePart.split(",")) {
			const privilege = raw.trim().replace(/\s+/g, " ").toUpperCase();
			if (privilege) privileges.add(privilege);
		}
	}
	return Array.from(privileges.values()).sort();
}

export function analyzeMysqlCapabilities(
	source: ResolvedDataSource,
	input: {
		currentUser?: string;
		grants: string[];
	},
): CapabilityCheckResult {
	const privileges = extractMysqlPrivilegesFromGrantStrings(input.grants);
	const findings: CapabilityFinding[] = [];
	if (input.grants.length === 0) {
		findings.push(makeFinding("info", "mysql_no_grants", "MySQL grants could not be inspected for the current user."));
	}
	if (!source.readOnly) {
		findings.push(makeFinding("warning", "mysql_source_not_read_only", "Datasource config is not marked read_only."));
	}
	if (source.allowApply) {
		findings.push(makeFinding("warning", "mysql_apply_opt_in", "Datasource config enables allow_apply."));
	}
	findings.push(...summarizeRiskyPrivileges(privileges, MYSQL_RISKY_PRIVILEGES, "mysql"));
	if (hasPrivilege(privileges, "ALL PRIVILEGES")) {
		findings.push(makeFinding("warning", "mysql_all_privileges", "Account appears to have ALL PRIVILEGES."));
	}
	if (hasPrivilege(privileges, "SELECT")) {
		findings.push(makeFinding("info", "mysql_select_present", "SELECT privilege detected."));
	} else if (input.grants.length > 0) {
		findings.push(makeFinding("warning", "mysql_select_missing", "SELECT privilege was not found in inspected grants."));
	}
	return {
		checked: true,
		current_user: input.currentUser,
		grants_inspected: input.grants.length > 0,
		grant_count: input.grants.length,
		privileges,
		findings,
	};
}

function normalizeClickHousePrivilege(privilege: string): string {
	return privilege.trim().replace(/\s+/g, " ").toUpperCase();
}

export function analyzeClickHouseCapabilities(
	source: ResolvedDataSource,
	input: {
		currentUser?: string;
		grants: string[];
		privileges: string[];
		readonlySetting?: number;
		allowDdlSetting?: number;
	},
): CapabilityCheckResult {
	const privileges = [...new Set(input.privileges.map(normalizeClickHousePrivilege).filter(Boolean))].sort();
	const findings: CapabilityFinding[] = [];
	if (input.grants.length === 0 && privileges.length === 0) {
		findings.push(makeFinding("info", "clickhouse_no_grants", "ClickHouse grants could not be inspected for the current user."));
	}
	if (input.readonlySetting === 0) {
		findings.push(makeFinding("warning", "clickhouse_readonly_off", "ClickHouse session readonly setting is 0."));
	}
	if (input.allowDdlSetting === 1) {
		findings.push(makeFinding("warning", "clickhouse_allow_ddl_on", "ClickHouse session allow_ddl setting is 1."));
	}
	if (!source.readOnly) {
		findings.push(makeFinding("warning", "clickhouse_source_not_read_only", "Datasource config is not marked read_only."));
	}
	if (source.allowApply) {
		findings.push(makeFinding("warning", "clickhouse_apply_opt_in", "Datasource config enables allow_apply."));
	}
	findings.push(...summarizeRiskyPrivileges(privileges, CLICKHOUSE_RISKY_PRIVILEGES, "clickhouse"));
	if (hasPrivilege(privileges, "SELECT")) {
		findings.push(makeFinding("info", "clickhouse_select_present", "SELECT privilege detected."));
	} else if (privileges.length > 0) {
		findings.push(makeFinding("warning", "clickhouse_select_missing", "SELECT privilege was not found in inspected grants."));
	}
	return {
		checked: true,
		current_user: input.currentUser,
		grants_inspected: input.grants.length > 0 || privileges.length > 0,
		grant_count: input.grants.length,
		privileges,
		readonly_setting: input.readonlySetting,
		allow_ddl_setting: input.allowDdlSetting,
		findings,
	};
}
