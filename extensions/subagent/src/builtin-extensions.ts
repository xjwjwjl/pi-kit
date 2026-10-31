/**
 * builtin-extensions.ts — the built-in extension factories a child may load.
 *
 * `DefaultResourceLoader` resolves a `builtin:<name>` path only against the
 * factories passed to it, so this list is what makes a requested built-in
 * extension loadable in a child instead of failing with the loader's "Unknown
 * built-in extension" diagnostic.
 *
 * These are the built-in extension factories the SDK root exports. `llama.cpp`
 * is not exported from the package root, so it is intentionally unsupported:
 * the tool-selection resolver rejects it with a clear error rather than letting
 * the loader produce a diagnostic that does not say why.
 */

import {
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
} from "@earendil-works/pi-coding-agent";
import type { InlineExtension, RegisteredMcpServer } from "@earendil-works/pi-coding-agent";

// `satisfies` rather than an annotation: the loader gets an `InlineExtension[]`,
// while `SUPPORTED_BUILTIN_EXTENSIONS` can still read the literal names.
export const BUILTIN_EXTENSION_FACTORIES = [
	{ name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true },
	{ name: "tool-search", factory: createToolSearchExtension(), builtin: true, replaceable: true },
	{ name: "mcp", factory: createMcpExtension(), builtin: true, replaceable: true },
] satisfies InlineExtension[];

/** The `builtin:<name>` names a child can load, derived from the factories above. */
export const SUPPORTED_BUILTIN_EXTENSIONS = new Set<string>(
	BUILTIN_EXTENSION_FACTORIES.map((entry) => entry.name),
);

/** Register copied configs before session_start, without running their parent extensions. */
export function childExtensionFactories(servers: readonly RegisteredMcpServer[] = []): InlineExtension[] {
	if (servers.length === 0) return BUILTIN_EXTENSION_FACTORIES;
	return [...BUILTIN_EXTENSION_FACTORIES, {
		name: "subagent-mcp-registrations",
		factory: (pi) => {
			// Another explicit tool grant may already have loaded the registrar.
			// Match SDK namespaces so a hyphen/underscore alias cannot collide either.
			const existing = new Set(pi.getMcpServers().map((server) => server.name.replaceAll("-", "_")));
			for (const { name, config } of servers) {
				const key = name.replaceAll("-", "_");
				if (existing.has(key)) continue;
				pi.registerMcpServer(name, config);
				existing.add(key);
			}
		},
	}];
}
