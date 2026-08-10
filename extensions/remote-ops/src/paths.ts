import path from "node:path";

export class RemoteOpsPathError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RemoteOpsPathError";
	}
}

export function resolveRemotePath(cwd: string, input: string | undefined, fallbackFileName?: string): string {
	const value = input ?? fallbackFileName;
	if (!value) throw new RemoteOpsPathError("A relative remote path is required");
	if (value.includes("\u0000") || value.includes("\n") || value.includes("\r") || value.includes("\\") || value.startsWith("/")) {
		throw new RemoteOpsPathError("Remote paths must be relative POSIX paths");
	}
	const normalizedRoot = path.posix.normalize(cwd);
	const resolved = path.posix.resolve(normalizedRoot, value);
	if (!isPosixPathInside(normalizedRoot, resolved)) {
		throw new RemoteOpsPathError(`Remote path escapes configured cwd: ${value}`);
	}
	return resolved;
}

function isPosixPathInside(root: string, candidate: string): boolean {
	if (root === "/") return candidate.startsWith("/");
	return candidate === root || candidate.startsWith(`${root}/`);
}
