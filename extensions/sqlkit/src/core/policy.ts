import type { ResolvedDataSource } from "../types.js";

function describeQuerySourcePolicy(source: ResolvedDataSource): string {
	return `${source.name} (${source.dialect}; read_only=${source.readOnly}; allow_apply=${source.allowApply})`;
}

function isWriteOptIn(source: ResolvedDataSource): boolean {
	return source.allowApply || !source.readOnly;
}

function sqlkitReadOnlyToolsNote(): string {
	return "SQLKit v1 exposes read-oriented query tools only. sql_run_query/profile/explain/analyze block write, DDL, admin, and session-setting SQL even if source config has write opt-ins.";
}

export function policyWarningForSource(source: ResolvedDataSource): string | undefined {
	if (!isWriteOptIn(source)) return undefined;
	const bits: string[] = [];
	if (!source.readOnly) bits.push("read_only=false");
	if (source.allowApply) bits.push("allow_apply=true");
	return `${sqlkitReadOnlyToolsNote()} Source ${describeQuerySourcePolicy(source)} has ${bits.join(", ")}. Do not edit sqlkit.json merely to bypass this policy unless the user explicitly requests a SQLKit configuration change.`;
}
