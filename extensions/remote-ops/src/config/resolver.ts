import { RemoteOpsConfigError } from "./schema.js";
import type { RemoteExecProfile, RemoteOpsConfig } from "./types.js";

export function resolveProfile(config: RemoteOpsConfig, name: string): RemoteExecProfile {
	const profile = config.profiles[name];
	if (!profile) throw new RemoteOpsConfigError(`Unknown profile "${name}"`);
	return profile;
}

export function resolveTimeout(
	requested: number | undefined,
	profile: { defaultTimeout?: number; maxTimeout?: number },
	fallback: number,
): number {
	const timeout = requested ?? profile.defaultTimeout ?? fallback;
	if (!Number.isInteger(timeout) || timeout <= 0) {
		throw new RemoteOpsConfigError("timeout must be a positive integer");
	}
	if (profile.maxTimeout !== undefined && timeout > profile.maxTimeout) {
		throw new RemoteOpsConfigError(`timeout ${timeout} exceeds profile maximum ${profile.maxTimeout}`);
	}
	return timeout;
}
