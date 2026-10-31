import { access } from "node:fs/promises";

async function exists(url) {
  try {
    await access(url);
    return true;
  } catch {
    return false;
  }
}

const extensionRoot = new URL("../", import.meta.url);

function isExtensionModule(parentURL) {
  return typeof parentURL === "string" && parentURL.startsWith(extensionRoot.href);
}

export async function resolve(specifier, context, nextResolve) {
  // Stub typebox only for the extension's own modules so real Pi internals
  // (which need the real typebox) keep working when a probe imports both.
  if (specifier === "typebox" && isExtensionModule(context.parentURL)) {
    return { url: new URL("./stubs/typebox.ts", import.meta.url).href, shortCircuit: true };
  }

  if ((specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) && specifier.endsWith(".js")) {
    const candidate = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL ?? import.meta.url);
    if (await exists(candidate)) return { url: candidate.href, shortCircuit: true };
  }

  return nextResolve(specifier, context);
}
