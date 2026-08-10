export const REMOTE_OPS_CONFIG_VERSION = 3 as const;

export type RemoteExecPolicy = "read-only" | "confirm-write" | "confirm-all";

export interface RemoteExecProfile {
	description?: string;
	/** Proxy hostname or IP. */
	host: string;
	/** Proxy listen port. */
	port: number;
	/** Bearer token for proxy authentication. */
	token: string;
	/** Default command start directory, not an access-control boundary. */
	cwd: string;
	defaultTimeout?: number;
	maxTimeout?: number;
	policy: RemoteExecPolicy;
}

export interface RemoteOpsConfig {
	version: typeof REMOTE_OPS_CONFIG_VERSION;
	profiles: Record<string, RemoteExecProfile>;
}
