/**
 * Safe Guard extension
 *
 * System-assistant oriented guardrails:
 * - Trusted roots for read/write (strategy S)
 * - Sensitive path protection (hard deny + strong confirm)
 * - High-value overwrite confirmation
 * - Bash dangerous-command confirmation (pattern mode)
 * - Bash redirection path checks (at least sensitive/outside roots)
 * - Session + persistent allow decisions
 * - Non-interactive behavior configurable (default fail-closed)
 */
import {
	getAgentDir,
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type AccessScope = "read" | "write";
type NonInteractiveMode = "fail-closed" | "fail-open";

type Decision = "allow_once" | "allow_session" | "allow_always" | "block";

interface SafeGuardConfig {
	nonInteractive?: NonInteractiveMode;
	roots?: {
		read?: string[];
		write?: string[];
	};
	alwaysAllow?: {
		readPaths?: string[];
		writePaths?: string[];
		bashCommands?: string[];
	};
	bash?: {
		dangerousPatterns?: string[];
		requireSudoConfirm?: boolean;
		confirmSensitiveRedirection?: boolean;
	};
}

interface SessionGrantEntry {
	kind: "path" | "command";
	scope: "read" | "write" | "bash";
	value: string;
	timestamp: number;
}

interface EffectivePolicy {
	nonInteractive: NonInteractiveMode;
	readRoots: string[];
	writeRoots: string[];
	alwaysReadPathKeys: Set<string>;
	alwaysWritePathKeys: Set<string>;
	alwaysBashCommands: Set<string>;
	dangerousBashPatterns: RegExp[];
	requireSudoConfirm: boolean;
	confirmSensitiveRedirection: boolean;
	globalConfigPath: string;
	projectConfigPath: string;
	canonicalCwd: string;
	projectRoot: string; // canonical project root
}

interface RedirectionTarget {
	rawPath: string;
	overwrite: boolean;
}

const SESSION_GRANT_ENTRY_TYPE = "safe-guard-grant";

/**
 * Default high-risk bash patterns.
 * NOTE: Keep these conservative; they gate with confirmation, not hard-block.
 */
const DEFAULT_BASH_DANGEROUS_PATTERNS: RegExp[] = [
	// rm with recursive+force (including split flags -r -f)
	/\brm\b[^\n\r;]*?(?:\s--recursive\b|\s-[^\n\r;]*\br\b)[^\n\r;]*?(?:\s--force\b|\s-[^\n\r;]*\bf\b)/i,
	/\brm\s+[^\n\r]*\-(?:[^\n\r\s]*r[^\n\r\s]*f|[^\n\r\s]*f[^\n\r\s]*r)/i,

	// PowerShell delete
	/\bremove-item\b[^\n\r]*\-recurse[^\n\r]*\-force/i,

	// Windows cmd delete patterns
	/\bdel\b[^\n\r]*\/(?:[^\n\r\s]*s[^\n\r\s]*f|[^\n\r\s]*f[^\n\r\s]*s)/i,
	/\brmdir\b[^\n\r]*\/s[^\n\r]*\/q/i,

	// disk / filesystem destruction
	/\bmkfs(\.[^\s]+)?\b/i,
	/\b(?:diskpart|format)\b/i,

	// dd writing to a block device (Linux/macOS)
	/\bdd\b[^\n\r]*\bof=\/dev\/(?:sd[a-z]\d*|nvme\d+n\d+(?:p\d+)?|mmcblk\d+(?:p\d+)?|rdisk\d+)\b/i,
	// dd writing to PhysicalDrive (Windows)
	/\bdd\b[^\n\r]*\bof=\\\\\.\\PhysicalDrive\d+\b/i,

	// permission footguns
	/\bchmod\s+777\b/i,

	// pipe-to-shell
	/\bcurl\b[^\n\r|]*\|\s*(?:sh|bash|zsh|pwsh?)\b/i,

	// git destructive cleanup
	/\bgit\s+clean\b[^\n\r]*(?:\s|^)-f\b[^\n\r]*(?:\s|^)-(?:d|x)\b/i,
];

const SUDO_PATTERN = /(^|\s)sudo(\s|$)/i;

function normalizeUnicodeSpaces(input: string): string {
	return input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
}

function stripAtPrefix(input: string): string {
	return input.startsWith("@") ? input.slice(1) : input;
}

function expandHome(input: string): string {
	const home = os.homedir();
	if (input === "~") return home;
	if (input.startsWith("~/") || input.startsWith("~\\")) {
		return path.join(home, input.slice(2));
	}
	return input;
}

function normalizePathInput(input: string): string {
	return expandHome(normalizeUnicodeSpaces(stripAtPrefix(input.trim())));
}

function toAbsolutePath(input: string, cwd: string, baseDir?: string): string {
	const normalized = normalizePathInput(input);
	if (normalized === "cwd") return cwd;
	if (normalized === "tmp") return os.tmpdir();
	if (path.isAbsolute(normalized)) return path.normalize(normalized);
	return path.resolve(baseDir ?? cwd, normalized);
}

/**
 * Resolve symlinks when possible.
 * If target doesn't exist, try to realpath the nearest existing parent, then re-attach tail.
 */
function safelyResolvePath(absolutePath: string): string {
	const resolved = path.resolve(absolutePath);

	try {
		return fs.realpathSync(resolved);
	} catch {
		let current = resolved;
		while (true) {
			if (fs.existsSync(current)) {
				try {
					const canonicalBase = fs.realpathSync(current);
					const relativeTail = path.relative(current, resolved);
					return path.resolve(canonicalBase, relativeTail);
				} catch {
					break;
				}
			}

			const parent = path.dirname(current);
			if (parent === current) break;
			current = parent;
		}
		return resolved;
	}
}

function toComparePath(absolutePath: string): string {
	const nativeNormalized = path.normalize(absolutePath);
	const slashNormalized = nativeNormalized.replace(/\\/g, "/");
	return process.platform === "win32" ? slashNormalized.toLowerCase() : slashNormalized;
}

function toPathKey(absolutePath: string): string {
	return toComparePath(safelyResolvePath(absolutePath));
}

function toCommandKey(command: string): string {
	return command.trim().replace(/\s+/g, " ");
}

function isSubpath(targetAbsolutePath: string, rootAbsolutePath: string): boolean {
	const target = toComparePath(targetAbsolutePath);
	const rootRaw = toComparePath(rootAbsolutePath);
	const root = rootRaw.endsWith("/") ? rootRaw.slice(0, -1) : rootRaw;
	return target === root || target.startsWith(`${root}/`);
}

function uniqPaths(paths: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const p of paths) {
		const key = toComparePath(p);
		if (!seen.has(key)) {
			seen.add(key);
			out.push(p);
		}
	}
	return out;
}

function parseNonInteractiveMode(value: string | undefined): NonInteractiveMode | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "fail-open" || normalized === "open" || normalized === "1" || normalized === "true") {
		return "fail-open";
	}
	if (normalized === "fail-closed" || normalized === "closed" || normalized === "0" || normalized === "false") {
		return "fail-closed";
	}
	return undefined;
}

function readJsonConfig(filePath: string): SafeGuardConfig {
	try {
		if (!fs.existsSync(filePath)) return {};
		const raw = fs.readFileSync(filePath, "utf-8");
		if (!raw.trim()) return {};
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== "object" || parsed === null) return {};
		return parsed as SafeGuardConfig;
	} catch {
		return {};
	}
}

function normalizeConfiguredPaths(pathsInput: string[] | undefined, cwd: string, baseDir: string): string[] {
	if (!pathsInput || pathsInput.length === 0) return [];
	const out: string[] = [];
	for (const p of pathsInput) {
		if (!p || typeof p !== "string") continue;
		out.push(safelyResolvePath(toAbsolutePath(p, cwd, baseDir)));
	}
	return uniqPaths(out);
}

/**
 * Find a stable "project root" by walking upward from cwd.
 * Preference: directory containing ".pi" or ".git" or "package.json".
 */
function discoverProjectRoot(cwd: string): string {
	let cur = safelyResolvePath(cwd);
	for (let i = 0; i < 50; i++) {
		try {
			if (fs.existsSync(path.join(cur, ".pi"))) return cur;
			if (fs.existsSync(path.join(cur, ".git"))) return cur;
			if (fs.existsSync(path.join(cur, "package.json"))) return cur;
		} catch {
			// ignore
		}
		const parent = path.dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	return safelyResolvePath(cwd);
}

function buildDefaultRoots(cwd: string, projectRoot: string): { read: string[]; write: string[] } {
	const home = os.homedir();
	const docs = path.join(home, "Documents");
	const downloads = path.join(home, "Downloads");
	const temp = os.tmpdir();
	const unixTmp = process.platform === "win32" ? [] : ["/tmp"];

	const readRoots = uniqPaths([
		safelyResolvePath(projectRoot),
		safelyResolvePath(cwd),
		safelyResolvePath(home),
		safelyResolvePath(docs),
		safelyResolvePath(downloads),
		safelyResolvePath(temp),
		...unixTmp.map((p) => safelyResolvePath(p)),
	]);

	const writeRoots = uniqPaths([
		safelyResolvePath(projectRoot),
		safelyResolvePath(cwd),
		safelyResolvePath(docs),
		safelyResolvePath(downloads),
		safelyResolvePath(temp),
		...unixTmp.map((p) => safelyResolvePath(p)),
	]);

	return { read: readRoots, write: writeRoots };
}

function compileBashPatterns(customPatterns: string[] | undefined): RegExp[] {
	const compiled = [...DEFAULT_BASH_DANGEROUS_PATTERNS];
	if (customPatterns) {
		for (const p of customPatterns) {
			try {
				compiled.push(new RegExp(p, "i"));
			} catch {
				// ignore invalid custom patterns
			}
		}
	}
	return compiled;
}

function buildEffectivePolicy(cwd: string): EffectivePolicy {
	const canonicalCwd = safelyResolvePath(cwd);
	const projectRoot = discoverProjectRoot(cwd);

	const globalConfigPath = path.join(getAgentDir(), "safe-guard.json");
	const projectConfigPath = path.join(projectRoot, ".pi", "safe-guard.json");

	const globalConfig = readJsonConfig(globalConfigPath);
	const projectConfig = readJsonConfig(projectConfigPath);

	const defaults = buildDefaultRoots(cwd, projectRoot);

	const globalBase = path.dirname(globalConfigPath);
	const projectBase = path.dirname(projectConfigPath);

	const readRoots =
		projectConfig.roots?.read !== undefined
			? normalizeConfiguredPaths(projectConfig.roots.read, cwd, projectBase)
			: globalConfig.roots?.read !== undefined
				? normalizeConfiguredPaths(globalConfig.roots.read, cwd, globalBase)
				: defaults.read;

	const writeRoots =
		projectConfig.roots?.write !== undefined
			? normalizeConfiguredPaths(projectConfig.roots.write, cwd, projectBase)
			: globalConfig.roots?.write !== undefined
				? normalizeConfiguredPaths(globalConfig.roots.write, cwd, globalBase)
				: defaults.write;

	const alwaysRead = [
		...normalizeConfiguredPaths(globalConfig.alwaysAllow?.readPaths, cwd, globalBase),
		...normalizeConfiguredPaths(projectConfig.alwaysAllow?.readPaths, cwd, projectBase),
	];
	const alwaysWrite = [
		...normalizeConfiguredPaths(globalConfig.alwaysAllow?.writePaths, cwd, globalBase),
		...normalizeConfiguredPaths(projectConfig.alwaysAllow?.writePaths, cwd, projectBase),
	];

	const alwaysBash = [
		...(globalConfig.alwaysAllow?.bashCommands ?? []),
		...(projectConfig.alwaysAllow?.bashCommands ?? []),
	]
		.filter((c) => typeof c === "string" && c.trim().length > 0)
		.map((c) => toCommandKey(c));

	const envMode = parseNonInteractiveMode(process.env.SAFE_GUARD_NON_INTERACTIVE);
	const configMode = projectConfig.nonInteractive ?? globalConfig.nonInteractive;
	const nonInteractive = envMode ?? configMode ?? "fail-closed";

	const dangerous = compileBashPatterns([
		...(globalConfig.bash?.dangerousPatterns ?? []),
		...(projectConfig.bash?.dangerousPatterns ?? []),
	]);

	return {
		nonInteractive,
		readRoots,
		writeRoots,
		alwaysReadPathKeys: new Set(alwaysRead.map((p) => toPathKey(p))),
		alwaysWritePathKeys: new Set(alwaysWrite.map((p) => toPathKey(p))),
		alwaysBashCommands: new Set(alwaysBash),
		dangerousBashPatterns: dangerous,
		requireSudoConfirm:
			projectConfig.bash?.requireSudoConfirm ?? globalConfig.bash?.requireSudoConfirm ?? true,
		confirmSensitiveRedirection:
			projectConfig.bash?.confirmSensitiveRedirection ??
			globalConfig.bash?.confirmSensitiveRedirection ??
			true,
		globalConfigPath,
		projectConfigPath,
		canonicalCwd,
		projectRoot: safelyResolvePath(projectRoot),
	};
}

function pathSegmentsLower(absolutePath: string): string[] {
	return toComparePath(absolutePath)
		.split("/")
		.filter((s) => s.length > 0)
		.map((s) => s.toLowerCase());
}

function basenameLower(absolutePath: string): string {
	return path.basename(absolutePath).toLowerCase();
}

function extLower(absolutePath: string): string {
	return path.extname(absolutePath).toLowerCase();
}

function isHardDenyPath(absolutePath: string): boolean {
	const segments = pathSegmentsLower(absolutePath);
	const base = basenameLower(absolutePath);
	const ext = extLower(absolutePath);

	// strong secrets
	if (segments.includes(".gnupg")) return true;
	if (base === "id_rsa" || base === "id_ed25519") return true;
	if (ext === ".pem" || ext === ".key" || ext === ".p12" || ext === ".pfx" || ext === ".kdbx") return true;

	// agent config can carry secrets; hard-deny only obvious secret-bearing names
	if (segments.includes(".pi")) {
		if (/(secret|token|credential|passwd|password)/i.test(base)) return true;
	}

	return false;
}

function isSensitiveConfirmPath(absolutePath: string): boolean {
	const compare = toComparePath(absolutePath);
	const segments = pathSegmentsLower(absolutePath);
	const base = basenameLower(absolutePath);

	// env / secrets-ish
	if (base === ".env" || base.startsWith(".env.")) return true;
	if (segments.includes(".ssh") || segments.includes(".aws") || segments.includes(".kube")) return true;

	// git metadata + agent config should be guarded
	if (segments.includes(".git")) return true;
	if (segments.includes(".pi")) return true;

	// OS protected areas
	if (process.platform === "win32") {
		if (/^[a-z]:\/windows(?:\/|$)/i.test(compare)) return true;
		if (/^[a-z]:\/program files(?: \(x86\))?(?:\/|$)/i.test(compare)) return true;
	} else {
		if (compare === "/etc" || compare.startsWith("/etc/")) return true;
		if (compare === "/system" || compare.startsWith("/system/")) return true;
		if (compare === "/library" || compare.startsWith("/library/")) return true;
	}

	return false;
}

function isHighValueOverwritePath(absolutePath: string): boolean {
	const base = basenameLower(absolutePath);
	const ext = extLower(absolutePath);

	if (base === ".env" || base.startsWith(".env.")) return true;
	if (base === "package.json") return true;
	if (base.startsWith("tsconfig") && ext === ".json") return true;
	if (base === ".gitignore" || base === ".gitattributes" || base === ".npmrc") return true;

	// git config is high value
	if (base === "config" && pathSegmentsLower(absolutePath).includes(".git")) return true;

	// key material
	if (base === "id_rsa" || base === "id_ed25519") return true;
	if (ext === ".pem" || ext === ".key" || ext === ".p12" || ext === ".pfx" || ext === ".kdbx") return true;

	// agent config files (guard overwrites)
	if (pathSegmentsLower(absolutePath).includes(".pi") && ext === ".json") return true;

	return false;
}

function hasExistingFile(absolutePath: string): boolean {
	try {
		if (!fs.existsSync(absolutePath)) return false;
		return fs.statSync(absolutePath).isFile();
	} catch {
		return false;
	}
}

function isPathGranted(
	scope: AccessScope,
	pathKey: string,
	policy: EffectivePolicy,
	sessionReadPathKeys: Set<string>,
	sessionWritePathKeys: Set<string>,
): boolean {
	if (scope === "read") {
		return sessionReadPathKeys.has(pathKey) || policy.alwaysReadPathKeys.has(pathKey);
	}
	return sessionWritePathKeys.has(pathKey) || policy.alwaysWritePathKeys.has(pathKey);
}

function isWithinTrustedRoots(scope: AccessScope, absolutePath: string, policy: EffectivePolicy): boolean {
	const roots = scope === "read" ? policy.readRoots : policy.writeRoots;
	return roots.some((root) => isSubpath(absolutePath, root));
}

function parseSessionGrant(data: unknown): SessionGrantEntry | undefined {
	if (!data || typeof data !== "object") return undefined;
	const raw = data as Record<string, unknown>;
	if (raw.kind !== "path" && raw.kind !== "command") return undefined;
	if (raw.scope !== "read" && raw.scope !== "write" && raw.scope !== "bash") return undefined;
	if (typeof raw.value !== "string" || raw.value.length === 0) return undefined;
	return {
		kind: raw.kind,
		scope: raw.scope,
		value: raw.value,
		timestamp: typeof raw.timestamp === "number" ? raw.timestamp : Date.now(),
	};
}

function ensureConfigDir(filePath: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function uniqueStringArray(values: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const v of values) {
		if (!seen.has(v)) {
			seen.add(v);
			out.push(v);
		}
	}
	return out;
}

function persistAlwaysPathGrant(policy: EffectivePolicy, scope: AccessScope, absolutePath: string): void {
	// prefer project config if under project root; otherwise global
	const targetPath = isSubpath(absolutePath, policy.projectRoot)
		? policy.projectConfigPath
		: policy.globalConfigPath;

	const existing = readJsonConfig(targetPath);

	if (!existing.alwaysAllow) existing.alwaysAllow = {};
	const normalizedPath = safelyResolvePath(absolutePath);

	if (scope === "read") {
		existing.alwaysAllow.readPaths = uniqueStringArray([...(existing.alwaysAllow.readPaths ?? []), normalizedPath]);
		policy.alwaysReadPathKeys.add(toPathKey(normalizedPath));
	} else {
		existing.alwaysAllow.writePaths = uniqueStringArray([...(existing.alwaysAllow.writePaths ?? []), normalizedPath]);
		policy.alwaysWritePathKeys.add(toPathKey(normalizedPath));
	}

	ensureConfigDir(targetPath);
	fs.writeFileSync(targetPath, `${JSON.stringify(existing, null, 2)}\n`, "utf-8");
}

function persistAlwaysCommandGrant(policy: EffectivePolicy, command: string): void {
	// keep "always allow command" project-scoped by default
	const targetPath = policy.projectConfigPath;
	const existing = readJsonConfig(targetPath);
	if (!existing.alwaysAllow) existing.alwaysAllow = {};
	const commandKey = toCommandKey(command);
	existing.alwaysAllow.bashCommands = uniqueStringArray([...(existing.alwaysAllow.bashCommands ?? []), commandKey]);
	policy.alwaysBashCommands.add(commandKey);

	ensureConfigDir(targetPath);
	fs.writeFileSync(targetPath, `${JSON.stringify(existing, null, 2)}\n`, "utf-8");
}

async function askDecision(
	ctx: ExtensionContext,
	policy: EffectivePolicy,
	title: string,
	message: string,
): Promise<Decision> {
	if (!ctx.hasUI) {
		return policy.nonInteractive === "fail-open" ? "allow_once" : "block";
	}

	const choice = await ctx.ui.select(title, [
		"Allow once",
		"Allow for session",
		"Always allow",
		"Block",
	]);

	if (choice === "Allow once") return "allow_once";
	if (choice === "Allow for session") return "allow_session";
	if (choice === "Always allow") return "allow_always";
	return "block";
}

async function applyPathDecision(options: {
	decision: Decision;
	scope: AccessScope;
	absolutePath: string;
	pathKey: string;
	ctx: ExtensionContext;
	pi: ExtensionAPI;
	policy: EffectivePolicy;
	sessionReadPathKeys: Set<string>;
	sessionWritePathKeys: Set<string>;
}): Promise<boolean> {
	const {
		decision,
		scope,
		absolutePath,
		pathKey,
		ctx,
		pi,
		policy,
		sessionReadPathKeys,
		sessionWritePathKeys,
	} = options;

	if (decision === "allow_once") return true;
	if (decision === "block") return false;

	if (decision === "allow_session") {
		if (scope === "read") {
			sessionReadPathKeys.add(pathKey);
		} else {
			sessionWritePathKeys.add(pathKey);
		}
		const entry: SessionGrantEntry = {
			kind: "path",
			scope,
			value: pathKey,
			timestamp: Date.now(),
		};
		pi.appendEntry(SESSION_GRANT_ENTRY_TYPE, entry);
		return true;
	}

	try {
		persistAlwaysPathGrant(policy, scope, absolutePath);
	} catch (err) {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`safe-guard: failed to persist always-allow rule: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
		}
		if (scope === "read") {
			sessionReadPathKeys.add(pathKey);
		} else {
			sessionWritePathKeys.add(pathKey);
		}
	}
	return true;
}

function extractRedirectionTargets(command: string): RedirectionTarget[] {
	const targets: RedirectionTarget[] = [];

	const redirectionRegex = /(?:^|\s)(>>|>)\s*(?:"([^"]+)"|'([^']+)'|([^\s|;&]+))/g;
	let match: RegExpExecArray | null;
	while ((match = redirectionRegex.exec(command)) !== null) {
		const op = match[1];
		const rawPath = (match[2] ?? match[3] ?? match[4] ?? "").trim();
		if (rawPath) {
			targets.push({ rawPath, overwrite: op === ">" });
		}
	}

	const teeRegex = /\btee\b\s+(?:-a\s+)?(?:"([^"]+)"|'([^']+)'|([^\s|;&]+))/gi;
	while ((match = teeRegex.exec(command)) !== null) {
		const rawPath = (match[1] ?? match[2] ?? match[3] ?? "").trim();
		if (rawPath) {
			targets.push({ rawPath, overwrite: false });
		}
	}

	// PowerShell path-ish switches (best effort)
	const psPathRegex = /(?:-Path|-LiteralPath)\s+(?:"([^"]+)"|'([^']+)'|([^\s|;&]+))/gi;
	while ((match = psPathRegex.exec(command)) !== null) {
		const rawPath = (match[1] ?? match[2] ?? match[3] ?? "").trim();
		if (rawPath) {
			targets.push({ rawPath, overwrite: false });
		}
	}

	return targets;
}

function buildReasonSummary(reasons: string[]): string {
	return reasons.map((r, i) => `${i + 1}. ${r}`).join("\n");
}

async function enforcePathPolicy(options: {
	ctx: ExtensionContext;
	pi: ExtensionAPI;
	policy: EffectivePolicy;
	scope: AccessScope;
	absolutePath: string;
	toolLabel: string;
	sessionReadPathKeys: Set<string>;
	sessionWritePathKeys: Set<string>;
	highValueOverwrite: boolean;
}): Promise<{ allowed: boolean; reason?: string }> {
	const {
		ctx,
		pi,
		policy,
		scope,
		absolutePath,
		toolLabel,
		sessionReadPathKeys,
		sessionWritePathKeys,
		highValueOverwrite,
	} = options;

	if (isHardDenyPath(absolutePath)) {
		return {
			allowed: false,
			reason: `safe-guard: blocked access to hard-deny path (${absolutePath})`,
		};
	}

	const pathKey = toPathKey(absolutePath);
	if (isPathGranted(scope, pathKey, policy, sessionReadPathKeys, sessionWritePathKeys)) {
		return { allowed: true };
	}

	const reasons: string[] = [];
	if (!isWithinTrustedRoots(scope, absolutePath, policy)) {
		reasons.push(`Path is outside trusted ${scope} roots`);
	}
	if (isSensitiveConfirmPath(absolutePath)) {
		reasons.push("Path is sensitive (requires confirmation)");
	}
	if (scope === "write" && highValueOverwrite) {
		reasons.push("Overwriting an existing high-value file");
	}

	if (reasons.length === 0) {
		return { allowed: true };
	}

	const decision = await askDecision(
		ctx,
		policy,
		`safe-guard: confirm ${toolLabel}`,
		`${buildReasonSummary(reasons)}\n\nPath: ${absolutePath}`,
	);

	const allowed = await applyPathDecision({
		decision,
		scope,
		absolutePath,
		pathKey,
		ctx,
		pi,
		policy,
		sessionReadPathKeys,
		sessionWritePathKeys,
	});

	if (!allowed) {
		return { allowed: false, reason: `safe-guard: blocked ${toolLabel} for ${absolutePath}` };
	}
	return { allowed: true };
}

async function applyCommandDecision(options: {
	decision: Decision;
	command: string;
	commandKey: string;
	ctx: ExtensionContext;
	pi: ExtensionAPI;
	policy: EffectivePolicy;
	sessionBashCommands: Set<string>;
}): Promise<boolean> {
	const { decision, command, commandKey, ctx, pi, policy, sessionBashCommands } = options;
	if (decision === "allow_once") return true;
	if (decision === "block") return false;

	if (decision === "allow_session") {
		sessionBashCommands.add(commandKey);
		const entry: SessionGrantEntry = {
			kind: "command",
			scope: "bash",
			value: commandKey,
			timestamp: Date.now(),
		};
		pi.appendEntry(SESSION_GRANT_ENTRY_TYPE, entry);
		return true;
	}

	try {
		persistAlwaysCommandGrant(policy, command);
	} catch (err) {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`safe-guard: failed to persist bash always-allow rule: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
		}
		sessionBashCommands.add(commandKey);
	}
	return true;
}

function makeBlockedUserBashResult(reason: string): {
	result: {
		output: string;
		exitCode: number;
		cancelled: false;
		truncated: false;
	};
} {
	return {
		result: {
			output: `${reason}\nCommand blocked by safe-guard.`,
			exitCode: 1,
			cancelled: false,
			truncated: false,
		},
	};
}

export default function safeGuardExtension(pi: ExtensionAPI) {
	// NOTE: policy must be built from the *session cwd* (ctx.cwd), not process.cwd().
	let policy = buildEffectivePolicy(process.cwd());

	const sessionReadPathKeys = new Set<string>();
	const sessionWritePathKeys = new Set<string>();
	const sessionBashCommands = new Set<string>();

	function reloadPolicyAndSessionGrants(ctx: ExtensionContext): void {
		policy = buildEffectivePolicy(ctx.cwd);

		sessionReadPathKeys.clear();
		sessionWritePathKeys.clear();
		sessionBashCommands.clear();

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType !== SESSION_GRANT_ENTRY_TYPE) continue;
			const grant = parseSessionGrant(entry.data);
			if (!grant) continue;

			if (grant.kind === "path") {
				if (grant.scope === "read") sessionReadPathKeys.add(grant.value);
				if (grant.scope === "write") sessionWritePathKeys.add(grant.value);
			} else if (grant.kind === "command" && grant.scope === "bash") {
				sessionBashCommands.add(grant.value);
			}
		}
	}

	async function evaluateBashCommand(
		command: string,
		cwd: string,
		ctx: ExtensionContext,
	): Promise<{ allowed: boolean; reason?: string }> {
		const commandKey = toCommandKey(command);
		const commandIsGranted = policy.alwaysBashCommands.has(commandKey) || sessionBashCommands.has(commandKey);

		if (!commandIsGranted) {
			const commandReasons: string[] = [];
			if (policy.requireSudoConfirm && SUDO_PATTERN.test(command)) {
				commandReasons.push("Command uses sudo");
			}
			if (policy.dangerousBashPatterns.some((p) => p.test(command))) {
				commandReasons.push("Command matches dangerous pattern");
			}

			if (commandReasons.length > 0) {
				const decision = await askDecision(
					ctx,
					policy,
					"safe-guard: confirm bash command",
					`${buildReasonSummary(commandReasons)}\n\nCommand:\n${command}`,
				);
				const allowed = await applyCommandDecision({
					decision,
					command,
					commandKey,
					ctx,
					pi,
					policy,
					sessionBashCommands,
				});
				if (!allowed) {
					return { allowed: false, reason: "safe-guard: blocked dangerous bash command" };
				}
			}
		}

		if (!policy.confirmSensitiveRedirection) {
			return { allowed: true };
		}

		const redirections = extractRedirectionTargets(command);
		for (const target of redirections) {
			// dynamic paths: don't try to resolve; rely on command-level checks
			if (target.rawPath.startsWith("$") || target.rawPath.includes("$") || target.rawPath.includes("`")) {
				continue;
			}

			const absolute = safelyResolvePath(toAbsolutePath(target.rawPath, cwd));
			const pathCheck = await enforcePathPolicy({
				ctx,
				pi,
				policy,
				scope: "write",
				absolutePath: absolute,
				toolLabel: "bash redirection",
				sessionReadPathKeys,
				sessionWritePathKeys,
				highValueOverwrite: target.overwrite && hasExistingFile(absolute) && isHighValueOverwritePath(absolute),
			});

			if (!pathCheck.allowed) {
				return { allowed: false, reason: pathCheck.reason };
			}
		}

		return { allowed: true };
	}

	pi.on("session_start", async (_event, ctx) => {
		reloadPolicyAndSessionGrants(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		reloadPolicyAndSessionGrants(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		reloadPolicyAndSessionGrants(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		const cwd = ctx.cwd;

		if (isToolCallEventType("read", event)) {
			const absolute = safelyResolvePath(toAbsolutePath(event.input.path, cwd));
			const result = await enforcePathPolicy({
				ctx,
				pi,
				policy,
				scope: "read",
				absolutePath: absolute,
				toolLabel: "read",
				sessionReadPathKeys,
				sessionWritePathKeys,
				highValueOverwrite: false,
			});
			if (!result.allowed) return { block: true, reason: result.reason ?? "safe-guard blocked read" };
			return;
		}

		if (isToolCallEventType("ls", event)) {
			const raw = event.input.path ?? ".";
			const absolute = safelyResolvePath(toAbsolutePath(raw, cwd));
			const result = await enforcePathPolicy({
				ctx,
				pi,
				policy,
				scope: "read",
				absolutePath: absolute,
				toolLabel: "ls",
				sessionReadPathKeys,
				sessionWritePathKeys,
				highValueOverwrite: false,
			});
			if (!result.allowed) return { block: true, reason: result.reason ?? "safe-guard blocked ls" };
			return;
		}

		if (isToolCallEventType("find", event)) {
			const raw = event.input.path ?? ".";
			const absolute = safelyResolvePath(toAbsolutePath(raw, cwd));
			const result = await enforcePathPolicy({
				ctx,
				pi,
				policy,
				scope: "read",
				absolutePath: absolute,
				toolLabel: "find",
				sessionReadPathKeys,
				sessionWritePathKeys,
				highValueOverwrite: false,
			});
			if (!result.allowed) return { block: true, reason: result.reason ?? "safe-guard blocked find" };
			return;
		}

		if (isToolCallEventType("grep", event)) {
			const raw = event.input.path ?? ".";
			const absolute = safelyResolvePath(toAbsolutePath(raw, cwd));
			const result = await enforcePathPolicy({
				ctx,
				pi,
				policy,
				scope: "read",
				absolutePath: absolute,
				toolLabel: "grep",
				sessionReadPathKeys,
				sessionWritePathKeys,
				highValueOverwrite: false,
			});
			if (!result.allowed) return { block: true, reason: result.reason ?? "safe-guard blocked grep" };
			return;
		}

		if (isToolCallEventType("edit", event)) {
			const absolute = safelyResolvePath(toAbsolutePath(event.input.path, cwd));
			const result = await enforcePathPolicy({
				ctx,
				pi,
				policy,
				scope: "write",
				absolutePath: absolute,
				toolLabel: "edit",
				sessionReadPathKeys,
				sessionWritePathKeys,
				highValueOverwrite: false,
			});
			if (!result.allowed) return { block: true, reason: result.reason ?? "safe-guard blocked edit" };
			return;
		}

		if (isToolCallEventType("write", event)) {
			const absolute = safelyResolvePath(toAbsolutePath(event.input.path, cwd));
			const overwriteHighValue = hasExistingFile(absolute) && isHighValueOverwritePath(absolute);
			const result = await enforcePathPolicy({
				ctx,
				pi,
				policy,
				scope: "write",
				absolutePath: absolute,
				toolLabel: "write",
				sessionReadPathKeys,
				sessionWritePathKeys,
				highValueOverwrite: overwriteHighValue,
			});
			if (!result.allowed) return { block: true, reason: result.reason ?? "safe-guard blocked write" };
			return;
		}

		if (isToolCallEventType("bash", event)) {
			const result = await evaluateBashCommand(event.input.command, cwd, ctx);
			if (!result.allowed) {
				return { block: true, reason: result.reason ?? "safe-guard blocked bash command" };
			}
			return;
		}
	});

	pi.on("user_bash", async (event, ctx) => {
		const cwd = event.cwd ?? ctx.cwd;
		const result = await evaluateBashCommand(event.command, cwd, ctx);
		if (!result.allowed) {
			return makeBlockedUserBashResult(result.reason ?? "safe-guard blocked bash command");
		}
		return undefined;
	});
}
