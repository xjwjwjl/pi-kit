/**
 * child-policy.ts — what a child session is never allowed to do.
 *
 * Extracted so the policy is testable on its own and so the tool-selection
 * resolver can name the same exclusions without importing the runner (which
 * pulls in the whole session SDK).
 *
 * Kept free of any `ExtensionAPI` dependency so it can be unit-tested.
 */

/**
 * Delegation tools a child must never receive: nested extension instances have
 * their own executors, so recursion would evade the parent's concurrency limit.
 *
 * Declared here rather than guarded at registration time, because that cannot
 * work. A child loads this extension as a **separate module instance in the same
 * process** (measured: `globalThis` is shared while a module-level counter is
 * not), and the resource loader drops async context across its own boundaries
 * (measured: `AsyncLocalStorage` read back `false` from inside the loader). A
 * registration-time guard therefore saw `false` however it was written.
 * `excludeTools` is declarative and needs no detection — and it wins over an
 * allowlist, so a definition cannot re-enable these by naming them.
 */
/**
 * This extension's delegation tools. Other extensions can expose their own
 * delegation tools under different names; those must be excluded explicitly by
 * the parent, because this list is deliberately name-based and not a capability
 * detector.
 */
export const SUBAGENT_TOOLS = ["agent", "agent_send", "agent_result"] as const;

/**
 * Tools that are never useful in a child, whatever an extension or a definition
 * asks for.
 *
 * `ask_user` is registered by the local `ask` extension; a child has no user to
 * ask, so it must stay unreachable even when its extension is loaded for some
 * other tool. Excluding a name that is not registered is harmless.
 */
export const CHILD_EXCLUDED_TOOLS = [...SUBAGENT_TOOLS, "ask_user"] as const;

/**
 * The exclusions every child gets, including operator-configured ones.
 *
 * `ask_user` is a name, not a capability: if the local UI tool is renamed, the
 * hardcoded entry stops matching and a child that loads the extension for some
 * other tool would get it. `PI_SUBAGENT_EXCLUDED_TOOLS` (comma-separated) is
 * the escape hatch — it adds names without weakening the defaults.
 *
 * Deduplicated so a name configured twice, or one that is already hardcoded,
 * does not show up twice in `excludeTools`.
 */
export function childExcludedTools(): readonly string[] {
	const configured = (process.env.PI_SUBAGENT_EXCLUDED_TOOLS ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
	return [...new Set([...CHILD_EXCLUDED_TOOLS, ...configured])];
}

/**
 * The exclusions every child gets, whatever its definition asks for.
 *
 * This list is what stops recursion and UI tools that need a human, so it must
 * not be checkable only by reading `createChildSession`.
 */
export function childExcludeTools(definition?: readonly string[]): string[] {
	return [...childExcludedTools(), ...(definition ?? [])];
}
