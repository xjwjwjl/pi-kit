const childProcessStub = new URL("./stubs/child-process.ts", import.meta.url);

export async function resolve(specifier, context, nextResolve) {
	if (specifier === "node:child_process") return { url: childProcessStub.href, shortCircuit: true };
	if (specifier === "node:child_process?native") return { url: "node:child_process", shortCircuit: true };
	return nextResolve(specifier, context);
}
