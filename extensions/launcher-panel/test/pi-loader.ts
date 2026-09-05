/**
 * Resolve hooks that redirect the pi runtime packages to local test stubs.
 * The packages are provided by pi itself and are never installed here, so
 * plain resolution would fail while unit-testing the panel modules.
 *
 * Registered from launcher.test.ts via module.register() before any panel
 * module is imported.
 */

const stubs = new Map([
	["@earendil-works/pi-tui", new URL("./stubs/pi-tui.ts", import.meta.url)],
	["@earendil-works/pi-coding-agent", new URL("./stubs/pi-coding-agent.ts", import.meta.url)],
]);

export async function resolve(specifier: string, context: any, nextResolve: any): Promise<any> {
	const stub = stubs.get(specifier);
	if (stub) {
		return { url: stub.href, shortCircuit: true };
	}
	try {
		return await nextResolve(specifier, context);
	} catch (error) {
		// With resolve hooks registered, Node no longer tries .ts for
		// extensionless relative imports (strip-types auto-resolution is
		// disabled); retry explicitly with the .ts suffix.
		if (
			(error as { code?: string }).code === "ERR_MODULE_NOT_FOUND" &&
			(specifier.startsWith("./") || specifier.startsWith("../")) &&
			!specifier.endsWith(".ts")
		) {
			return nextResolve(`${specifier}.ts`, context);
		}
		throw error;
	}
}
