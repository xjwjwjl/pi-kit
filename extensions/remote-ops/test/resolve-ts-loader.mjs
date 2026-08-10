import { access } from "node:fs/promises";

async function exists(url) {
	try {
		await access(url);
		return true;
	} catch {
		return false;
	}
}

export async function resolve(specifier, context, nextResolve) {
	if ((specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) && specifier.endsWith(".js")) {
		const candidate = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL ?? import.meta.url);
		if (await exists(candidate)) return { url: candidate.href, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}
