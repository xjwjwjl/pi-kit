function normalizePath(candidate: string): string {
	const stack: string[] = [];
	const absolute = candidate.startsWith("/") || candidate.startsWith("\\");
	for (const part of candidate.replace(/\\/g, "/").split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (stack.length > 0 && stack[stack.length - 1] !== "..") stack.pop();
			else if (!absolute) stack.push("..");
			continue;
		}
		stack.push(part);
	}
	return stack.join("/").toLowerCase();
}

function hasPathSuffix(path: string, suffix: string): boolean {
	return path === suffix || path.endsWith(`/${suffix}`);
}

function isPathUnder(path: string, base: string): boolean {
	return path === base || path.startsWith(`${base}/`) || path.includes(`/${base}/`) || path.endsWith(`/${base}`);
}

// ── protected paths (writes to these are blocked) ──

export function containsProtectedPath(paths: readonly string[]): boolean {
	return paths.some(isProtectedPath);
}

function isProtectedPath(candidate: string): boolean {
	const normalized = normalizePath(candidate);
	return /(?:^|\/)\.ssh\/authorized_keys$/.test(normalized) ||
		hasPathSuffix(normalized, "etc/passwd") ||
		hasPathSuffix(normalized, "etc/shadow") ||
		isPathUnder(normalized, "etc/sudoers") ||
		isPathUnder(normalized, "etc/sudoers.d") ||
		isPathUnder(normalized, "etc/ssh") ||
		/(?:^|\/)dev\/sd[a-z](?:[0-9]+)?(?:\/|$)/.test(normalized) ||
		isPathUnder(normalized, "proc/sys") ||
		isPathUnder(normalized, "sys");
}

// ── sensitive paths (reads from these are confirmed) ──

export function containsSensitivePath(paths: readonly string[]): string | undefined {
	for (const path of paths) {
		const reason = sensitivePathReason(path);
		if (reason) return reason;
	}
	return undefined;
}

function sensitivePathReason(candidate: string): string | undefined {
	const normalized = normalizePath(candidate);
	if (hasPathSuffix(normalized, "etc/shadow")) return "etc/shadow";
	if (hasPathSuffix(normalized, "etc/passwd")) return "etc/passwd";
	if (isPathUnder(normalized, "etc/ssh")) return "etc/ssh";
	if (isPathUnder(normalized, "etc/sudoers") || isPathUnder(normalized, "etc/sudoers.d")) return "etc/sudoers";
	if (/(?:^|\/)\.ssh(?:\/|$)/.test(normalized)) return "SSH material";
	if (/(?:^|\/)\.aws(?:\/|$)/.test(normalized) || isPathUnder(normalized, ".config/gcloud")) return "cloud credentials";
	if (/(?:^|\/)proc\/[^/]+\/environ$/.test(normalized)) return "process environment";
	const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
	if (basename === ".env" || basename.startsWith(".env.")) return "environment secrets";
	return undefined;
}
