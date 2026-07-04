import { access } from "node:fs/promises";

const STUBS = new Map([
	["@earendil-works/pi-coding-agent", new URL("./stubs/pi-coding-agent.ts", import.meta.url).href],
	["typebox", new URL("./stubs/typebox.ts", import.meta.url).href],
]);

async function exists(url) {
	try {
		await access(url);
		return true;
	} catch {
		return false;
	}
}

export async function resolve(specifier, context, nextResolve) {
	const stub = STUBS.get(specifier);
	if (stub) {
		return { url: stub, shortCircuit: true };
	}

	if ((specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) && specifier.endsWith(".js")) {
		const candidate = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL ?? import.meta.url);
		if (await exists(candidate)) {
			return { url: candidate.href, shortCircuit: true };
		}
	}

	return nextResolve(specifier, context);
}
