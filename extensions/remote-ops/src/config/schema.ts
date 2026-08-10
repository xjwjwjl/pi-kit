import { REMOTE_OPS_CONFIG_VERSION, type RemoteExecProfile, type RemoteOpsConfig } from "./types.js";

export class RemoteOpsConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RemoteOpsConfigError";
	}
}

type JsonRecord = Record<string, unknown>;

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseRemoteOpsConfig(value: unknown): RemoteOpsConfig {
	const root = expectRecord(value, "config");
	assertKnownKeys(root, ["version", "profiles"], "config");
	if (root.version !== REMOTE_OPS_CONFIG_VERSION) {
		throw new RemoteOpsConfigError(`config.version must be ${REMOTE_OPS_CONFIG_VERSION}`);
	}

	const profilesValue = expectRecord(root.profiles, "config.profiles");
	const profiles: Record<string, RemoteExecProfile> = {};
	for (const [name, raw] of Object.entries(profilesValue)) {
		assertName(name, `profile name "${name}"`);
		profiles[name] = parseProfile(raw, `config.profiles.${name}`);
	}

	return { version: REMOTE_OPS_CONFIG_VERSION, profiles };
}

function parseProfile(value: unknown, label: string): RemoteExecProfile {
	const record = expectRecord(value, label);
	assertKnownKeys(record, ["description", "host", "port", "token", "cwd", "defaultTimeout", "maxTimeout", "policy"], label);

	const timeouts = parseTimeouts(record, label);
	const port = expectPort(record.port, `${label}.port`);
	return {
		...(record.description === undefined ? {} : { description: expectDescription(record.description, `${label}.description`) }),
		host: expectNonEmptyString(record.host, `${label}.host`),
		port,
		token: expectNonEmptyString(record.token, `${label}.token`),
		cwd: expectAbsolutePosixPath(record.cwd, `${label}.cwd`),
		...timeouts,
		policy: expectPolicy(record.policy, `${label}.policy`),
	};
}

function parseTimeouts(record: JsonRecord, label: string): { defaultTimeout?: number; maxTimeout?: number } {
	const defaultTimeout =
		record.defaultTimeout === undefined
			? undefined
			: expectPositiveInteger(record.defaultTimeout, `${label}.defaultTimeout`);
	const maxTimeout =
		record.maxTimeout === undefined ? undefined : expectPositiveInteger(record.maxTimeout, `${label}.maxTimeout`);
	if (defaultTimeout !== undefined && maxTimeout !== undefined && defaultTimeout > maxTimeout) {
		throw new RemoteOpsConfigError(`${label}.defaultTimeout cannot exceed ${label}.maxTimeout`);
	}
	return {
		...(defaultTimeout === undefined ? {} : { defaultTimeout }),
		...(maxTimeout === undefined ? {} : { maxTimeout }),
	};
}

function expectRecord(value: unknown, label: string): JsonRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new RemoteOpsConfigError(`${label} must be an object`);
	}
	return value as JsonRecord;
}

function assertKnownKeys(value: JsonRecord, known: string[], label: string): void {
	const knownSet = new Set(known);
	for (const key of Object.keys(value)) {
		if (!knownSet.has(key)) throw new RemoteOpsConfigError(`${label} contains unknown field "${key}"`);
	}
}

function expectString(value: unknown, label: string): string {
	if (typeof value !== "string") throw new RemoteOpsConfigError(`${label} must be a string`);
	return value;
}

function expectNonEmptyString(value: unknown, label: string): string {
	const output = expectString(value, label).trim();
	if (!output) throw new RemoteOpsConfigError(`${label} must not be empty`);
	return output;
}

function expectPositiveInteger(value: unknown, label: string): number {
	if (!Number.isInteger(value) || (value as number) <= 0) {
		throw new RemoteOpsConfigError(`${label} must be a positive integer`);
	}
	return value as number;
}

function expectPort(value: unknown, label: string): number {
	const port = expectPositiveInteger(value, label);
	if (port > 65_535) throw new RemoteOpsConfigError(`${label} must be at most 65535`);
	return port;
}

function expectDescription(value: unknown, label: string): string {
	const description = expectNonEmptyString(value, label);
	if (/\r|\n/.test(description)) throw new RemoteOpsConfigError(`${label} must be a single line`);
	if (description.length > 240) throw new RemoteOpsConfigError(`${label} must be at most 240 characters`);
	return description;
}

function expectAbsolutePosixPath(value: unknown, label: string): string {
	const path = expectNonEmptyString(value, label);
	if (!path.startsWith("/") || path.includes("\\") || path.includes("\u0000")) {
		throw new RemoteOpsConfigError(`${label} must be an absolute POSIX path`);
	}
	return path;
}

function expectPolicy(value: unknown, label: string): "read-only" | "confirm-write" | "confirm-all" {
	if (value !== "read-only" && value !== "confirm-write" && value !== "confirm-all") {
		throw new RemoteOpsConfigError(`${label} must be read-only, confirm-write, or confirm-all`);
	}
	return value;
}

function assertName(name: string, label: string): void {
	if (!NAME_PATTERN.test(name)) {
		throw new RemoteOpsConfigError(`${label} must match ${NAME_PATTERN}`);
	}
}
