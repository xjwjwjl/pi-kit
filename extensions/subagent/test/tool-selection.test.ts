import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { resolveToolSelection, CORE_BUILTIN_TOOLS } from "../src/tool-selection.ts";

/** A tool as `pi.getAllTools()` reports it. */
function tool(
	name: string,
	path: string,
	options: { scope?: "user" | "project" | "temporary"; source?: string } = {},
): ToolInfo {
	return {
		name,
		description: "",
		parameters: {},
		sourceInfo: {
			path,
			source: options.source ?? "user",
			scope: options.scope ?? "user",
			origin: "top-level",
		},
	} as unknown as ToolInfo;
}

const lark = tool("lark_doc", "/ext/lark/index.ts");

test("CORE_BUILTIN_TOOLS is derived from the SDK's tool definition factories", () => {
	// The list comes from the SDK's `create*ToolDefinition` exports rather than a
	// hand-written copy, so this asserts the names a child is expected to have and
	// fails loudly if an upgrade renames one of them.
	for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"]) {
		assert.ok(CORE_BUILTIN_TOOLS.includes(name), `missing core tool "${name}"`);
	}
	assert.equal(new Set(CORE_BUILTIN_TOOLS).size, CORE_BUILTIN_TOOLS.length, "no duplicate names");
});

const EXCLUDED_ENV = "PI_SUBAGENT_EXCLUDED_TOOLS";

/** Run with a temporary env value and put the previous one back, even on failure. */
function withEnv(value: string | undefined, run: () => void): void {
	const previous = process.env[EXCLUDED_ENV];
	if (value === undefined) delete process.env[EXCLUDED_ENV];
	else process.env[EXCLUDED_ENV] = value;
	try {
		run();
	} finally {
		if (previous === undefined) delete process.env[EXCLUDED_ENV];
		else process.env[EXCLUDED_ENV] = previous;
	}
}

test("a requested extension tool becomes one extension path and a +name modifier", () => {
	const selection = resolveToolSelection({
		requested: ["lark_doc"],
		allTools: [lark],
		trusted: true,
	});

	assert.deepEqual(selection.extensionPaths, ["/ext/lark/index.ts"]);
	assert.deepEqual(selection.tools, ["+lark_doc"], "no definition allowlist means add to the defaults");
});

test("two tools from the same extension load it once", () => {
	const sheets = tool("lark_sheets", "/ext/lark/index.ts");
	const selection = resolveToolSelection({
		requested: ["lark_doc", "lark_sheets", "lark_doc"],
		allTools: [lark, sheets],
		trusted: true,
	});

	assert.deepEqual(selection.extensionPaths, ["/ext/lark/index.ts"]);
	assert.deepEqual(selection.tools, ["+lark_doc", "+lark_sheets"]);
});

test("a core built-in needs no extension path", () => {
	const read = tool("read", "builtin:read", { source: "builtin" });
	const selection = resolveToolSelection({
		requested: ["read"],
		allTools: [read],
		trusted: true,
	});

	assert.deepEqual(selection.extensionPaths, [], "the child already has it");
	assert.deepEqual(selection.tools, ["+read"]);
});

test("an extension that overrides a core built-in is loaded instead of skipped", () => {
	// A sandbox extension that replaces `bash` reports its own file path. The
	// name alone must not be enough to treat it as the built-in, or the child
	// silently gets the unsandboxed one.
	const sandboxBash = tool("bash", "/ext/sandbox/index.ts");
	const selection = resolveToolSelection({
		requested: ["bash"],
		allTools: [sandboxBash],
		trusted: true,
	});

	assert.deepEqual(selection.extensionPaths, ["/ext/sandbox/index.ts"]);
	assert.deepEqual(selection.tools, ["+bash"]);
});

test("an explicit core override records the extension the parent expects", () => {
	const sandboxBash = tool("bash", "/ext/sandbox/index.ts");
	const selection = resolveToolSelection({
		requested: ["bash"],
		allTools: [sandboxBash],
		trusted: true,
	});

	assert.deepEqual(selection.coreOverrides, [{ name: "bash", path: "/ext/sandbox/index.ts" }]);
});

test("an overriding tool with a builtin-looking source is still skipped", () => {
	// The other half of the same rule: when the registry really reports the
	// built-in, no path is handed to the loader.
	const builtinBash = tool("bash", "builtin:bash", { source: "builtin" });
	const selection = resolveToolSelection({ requested: ["bash"], allTools: [builtinBash], trusted: true });

	assert.deepEqual(selection.extensionPaths, []);
});

test("a built-in extension is passed as its builtin: path", () => {
	const codemode = tool("codemode", "builtin:codemode", { source: "builtin" });
	const selection = resolveToolSelection({
		requested: ["codemode"],
		allTools: [codemode],
		trusted: true,
	});

	assert.deepEqual(selection.extensionPaths, ["builtin:codemode"]);
	assert.deepEqual(selection.tools, ["+codemode"]);
});

test("an unsupported built-in extension is rejected with a clear error", () => {
	// The SDK does not export llama.cpp's factory, so `builtin:llama.cpp` cannot
	// be loaded in a child. It must fail here, naming the extension and what is
	// supported, instead of falling through to the loader's "Unknown built-in
	// extension" diagnostic.
	const llama = tool("llama", "builtin:llama.cpp", { source: "builtin" });

	assert.throws(
		() => resolveToolSelection({ requested: ["llama"], allTools: [llama], trusted: true }),
		(error: Error) => {
			assert.match(error.message, /cannot load/);
			assert.match(error.message, /llama\.cpp/);
			for (const name of ["codemode", "tool-search", "mcp"]) {
				assert.ok(error.message.includes(name), `the error names supported extension "${name}"`);
			}
			return true;
		},
	);
});

test("a definition allowlist gets the requested names appended", () => {
	const selection = resolveToolSelection({
		requested: ["lark_doc"],
		allTools: [lark],
		trusted: true,
		definitionTools: ["read", "bash"],
	});

	assert.deepEqual(selection.tools, ["read", "bash", "lark_doc"]);
});

test("a definition with +name/-name modifiers gets +name appended", () => {
	const selection = resolveToolSelection({
		requested: ["lark_doc"],
		allTools: [lark],
		trusted: true,
		definitionTools: ["+read", "-bash"],
	});

	assert.deepEqual(selection.tools, ["+read", "-bash", "+lark_doc"]);
});

test("a definition that mixes names and modifiers is rejected", () => {
	assert.throws(
		() =>
			resolveToolSelection({
				requested: ["lark_doc"],
				allTools: [lark],
				trusted: true,
				definitionTools: ["read", "+bash"],
			}),
		/mixes tool names/,
	);
});

test("an empty request leaves the definition selection untouched", () => {
	const selection = resolveToolSelection({
		requested: [],
		allTools: [lark],
		trusted: true,
		definitionTools: ["read"],
	});

	assert.deepEqual(selection.extensionPaths, []);
	assert.deepEqual(selection.tools, ["read"]);
});

test("an explicit empty definition allowlist gives the child no tools", () => {
	const selection = resolveToolSelection({
		requested: [],
		allTools: [lark],
		trusted: true,
		definitionTools: [],
	});

	assert.deepEqual(selection.extensionPaths, []);
	assert.deepEqual(selection.tools, [], "`tools: []` must not fall back to the defaults");
});

test("an explicit empty definition allowlist keeps a request as a plain allowlist", () => {
	const selection = resolveToolSelection({
		requested: ["lark_doc"],
		allTools: [lark],
		trusted: true,
		definitionTools: [],
	});

	assert.deepEqual(selection.extensionPaths, ["/ext/lark/index.ts"]);
	assert.deepEqual(selection.tools, ["lark_doc"], "a +name modifier would re-add the refused defaults");
});

test("loadDefinitionTools resolves nothing for an explicit empty definition allowlist", () => {
	const selection = resolveToolSelection({
		requested: [],
		allTools: [lark],
		trusted: true,
		definitionTools: [],
		loadDefinitionTools: true,
	});

	assert.deepEqual(selection.extensionPaths, []);
	assert.deepEqual(selection.tools, []);
});

test("an unknown tool is rejected instead of silently skipped", () => {
	assert.throws(
		() => resolveToolSelection({ requested: ["nope"], allTools: [lark], trusted: true }),
		/Unknown tool "nope"/,
	);
});

test("subagent tools and ask_user are rejected", () => {
	const agent = tool("agent", "/ext/subagent/index.ts");
	assert.throws(
		() => resolveToolSelection({ requested: ["agent"], allTools: [agent], trusted: true }),
		/cannot spawn or message other agents/,
	);
	assert.throws(
		() => resolveToolSelection({ requested: ["ask_user"], allTools: [tool("ask_user", "/ext/ask/index.ts")], trusted: true }),
		/no user to ask/,
	);
});

test("a project extension is gated by project trust", () => {
	const project = tool("lark_doc", "/project/ext/index.ts", { scope: "project" });

	assert.throws(
		() => resolveToolSelection({ requested: ["lark_doc"], allTools: [project], trusted: false }),
		/Trust the project/,
	);
	assert.deepEqual(
		resolveToolSelection({ requested: ["lark_doc"], allTools: [project], trusted: true }).extensionPaths,
		["/project/ext/index.ts"],
	);
});

test("another tool from the subagent extension is rejected", () => {
	const self = tool("agent", "/ext/subagent/index.ts");
	const future = tool("future_tool", "/ext/subagent/index.ts");

	assert.throws(
		() => resolveToolSelection({ requested: ["future_tool"], allTools: [self, future], trusted: true }),
		/subagent extension/,
	);
});

test("an SDK or inline tool cannot be loaded in a child", () => {
	const sdk = tool("sdk_tool", "<sdk:sdk_tool>", { source: "sdk" });
	assert.throws(
		() => resolveToolSelection({ requested: ["sdk_tool"], allTools: [sdk], trusted: true }),
		/SDK or inline/,
	);
});

test("a requested tool the definition disallows is a policy conflict", () => {
	assert.throws(
		() =>
			resolveToolSelection({
				requested: ["lark_doc"],
				allTools: [lark],
				trusted: true,
				disallowedTools: ["lark_doc"],
			}),
		/disallowed_tools/,
	);
});

test("a disallowed_tools glob pattern excludes a matching request", () => {
	// `excludeTools` accepts `*` patterns, so the resolver has to use the same
	// rule: approving `mcp__srv__tool` here loads its extension and then the
	// child silently lacks the tool.
	const mcp = tool("mcp__srv__tool", "/ext/mcp/index.ts");

	assert.throws(
		() =>
			resolveToolSelection({
				requested: ["mcp__srv__tool"],
				allTools: [mcp],
				trusted: true,
				disallowedTools: ["mcp__*"],
			}),
		/disallowed_tools pattern "mcp__\*"/,
	);
	assert.throws(
		() =>
			resolveToolSelection({
				requested: ["mcp__srv__tool"],
				allTools: [mcp],
				trusted: true,
				disallowedTools: ["*"],
			}),
		/disallowed_tools pattern "\*"/,
	);
});

test("a disallowed_tools pattern that does not match still allows the request", () => {
	const mcp = tool("mcp__srv__tool", "/ext/mcp/index.ts");
	const selection = resolveToolSelection({
		requested: ["mcp__srv__tool"],
		allTools: [mcp],
		trusted: true,
		disallowedTools: ["other__*"],
	});

	assert.deepEqual(selection.extensionPaths, ["/ext/mcp/index.ts"]);
});

test("a definition's -name removal cannot be re-enabled by a request", () => {
	const bash = tool("bash", "builtin:bash", { source: "builtin" });

	assert.throws(
		() =>
			resolveToolSelection({
				requested: ["bash"],
				allTools: [bash],
				trusted: true,
				definitionTools: ["+read", "-bash"],
			}),
		/Tool "bash" is removed by the agent definition/,
	);
	// A request for something else is unaffected.
	assert.deepEqual(
		resolveToolSelection({
			requested: ["lark_doc"],
			allTools: [lark],
			trusted: true,
			definitionTools: ["+read", "-bash"],
		}).tools,
		["+read", "-bash", "+lark_doc"],
	);
});

test("blank and duplicate names are ignored", () => {
	const selection = resolveToolSelection({
		requested: ["", "  ", "lark_doc", "lark_doc"],
		allTools: [lark],
		trusted: true,
	});

	assert.deepEqual(selection.extensionPaths, ["/ext/lark/index.ts"]);
	assert.deepEqual(selection.tools, ["+lark_doc"]);
});

test("loadDefinitionTools resolves the definition's allowlist without changing the selection", () => {
	const selection = resolveToolSelection({
		requested: [],
		allTools: [lark],
		trusted: true,
		definitionTools: ["lark_doc"],
		loadDefinitionTools: true,
	});

	assert.deepEqual(selection.extensionPaths, ["/ext/lark/index.ts"]);
	assert.deepEqual(selection.tools, ["lark_doc"], "the allowlist stays as written");
});

test("loadDefinitionTools resolves +name but skips core built-ins and -name", () => {
	const read = tool("read", "builtin:read", { source: "builtin" });
	const selection = resolveToolSelection({
		requested: [],
		allTools: [read, lark],
		trusted: true,
		definitionTools: ["read", "lark_doc"],
		loadDefinitionTools: true,
	});

	assert.deepEqual(selection.extensionPaths, ["/ext/lark/index.ts"], "`read` needs no path");
	assert.deepEqual(selection.tools, ["read", "lark_doc"]);

	const modifiers = resolveToolSelection({
		requested: [],
		allTools: [read, lark],
		trusted: true,
		definitionTools: ["+read", "-bash"],
		loadDefinitionTools: true,
	});

	assert.deepEqual(modifiers.extensionPaths, []);
	assert.deepEqual(modifiers.tools, ["+read", "-bash"]);
});

test("loadDefinitionTools resolves a +extensionTool to its extension", () => {
	const selection = resolveToolSelection({
		requested: [],
		allTools: [lark],
		trusted: true,
		definitionTools: ["+lark_doc", "-bash"],
		loadDefinitionTools: true,
	});

	assert.deepEqual(selection.extensionPaths, ["/ext/lark/index.ts"]);
	assert.deepEqual(selection.tools, ["+lark_doc", "-bash"], "the definition's modifiers stay as written");
});

test("loadDefinitionTools rejects an unknown +name definition tool", () => {
	assert.throws(
		() =>
			resolveToolSelection({
				requested: [],
				allTools: [lark],
				trusted: true,
				definitionTools: ["+nope"],
				loadDefinitionTools: true,
			}),
		/Unknown tool "nope"/,
	);
});

test("loadDefinitionTools rejects an unknown definition tool", () => {
	assert.throws(
		() =>
			resolveToolSelection({
				requested: [],
				allTools: [lark],
				trusted: true,
				definitionTools: ["nope"],
				loadDefinitionTools: true,
			}),
		/Unknown tool "nope"/,
	);
});

test("loadDefinitionTools gates a project extension on project trust", () => {
	const project = tool("lark_doc", "/project/ext/index.ts", { scope: "project" });

	assert.throws(
		() =>
			resolveToolSelection({
				requested: [],
				allTools: [project],
				trusted: false,
				definitionTools: ["lark_doc"],
				loadDefinitionTools: true,
			}),
		/Trust the project/,
	);
	assert.deepEqual(
		resolveToolSelection({
			requested: [],
			allTools: [project],
			trusted: true,
			definitionTools: ["lark_doc"],
			loadDefinitionTools: true,
		}).extensionPaths,
		["/project/ext/index.ts"],
	);
});

test("loadDefinitionTools applies disallowed_tools to the definition's own names", () => {
	assert.throws(
		() =>
			resolveToolSelection({
				requested: [],
				allTools: [lark],
				trusted: true,
				definitionTools: ["lark_doc"],
				disallowedTools: ["lark_*"],
				loadDefinitionTools: true,
			}),
		/disallowed_tools pattern "lark_\*"/,
	);
});

test("loadDefinitionTools rejects a pattern it cannot resolve", () => {
	assert.throws(
		() =>
			resolveToolSelection({
				requested: [],
				allTools: [lark],
				trusted: true,
				definitionTools: ["lark_*"],
				loadDefinitionTools: true,
			}),
		/is a pattern and cannot be resolved/,
	);
});

test("without loadDefinitionTools the definition's allowlist loads nothing", () => {
	const selection = resolveToolSelection({
		requested: [],
		allTools: [lark],
		trusted: true,
		definitionTools: ["lark_doc"],
	});

	assert.deepEqual(selection.extensionPaths, []);
	assert.deepEqual(selection.tools, ["lark_doc"]);
});

// The next cases lock the matcher to Pi's `createToolNameMatcher`: exact names
// plus `*` wildcards, with every other character escaped and the result anchored.
// They are a semantic contract, not a feature: a matcher that is broader than
// Pi's approves a tool the child's `excludeTools` then silently removes.
test("disallowed_tools matches exact names", () => {
	const mcp = tool("mcp__srv__tool", "/ext/mcp/index.ts");

	assert.throws(
		() =>
			resolveToolSelection({
				requested: ["mcp__srv__tool"],
				allTools: [mcp],
				trusted: true,
				disallowedTools: ["mcp__srv__tool"],
			}),
		/disallowed_tools\./,
	);
});

test("disallowed_tools treats * as .* and anchors the pattern", () => {
	const mcp = tool("mcp__srv__tool", "/ext/mcp/index.ts");
	const denies = (pattern: string): (() => unknown) => () =>
		resolveToolSelection({ requested: ["mcp__srv__tool"], allTools: [mcp], trusted: true, disallowedTools: [pattern] });

	assert.throws(denies("mcp__*"), /disallowed_tools pattern "mcp__\*"/, "prefix wildcard");
	assert.throws(denies("*"), /disallowed_tools pattern "\*"/, "bare star matches everything");
	assert.throws(denies("mcp__*__*"), /disallowed_tools pattern "mcp__\*__\*"/, "every star is a wildcard");
	assert.throws(denies("mcp__srv__*"), /disallowed_tools pattern/, "suffix wildcard");

	// Anchoring: the pattern must cover the whole name.
	assert.deepEqual(
		resolveToolSelection({
			requested: ["mcp__srv__tool"],
			allTools: [mcp],
			trusted: true,
			disallowedTools: ["srv__tool"],
		}).extensionPaths,
		["/ext/mcp/index.ts"],
	);
});

test("disallowed_tools escapes regex metacharacters", () => {
	// `mcp__a.b__*` must mean a literal dot, not "any character": otherwise a
	// disallowed pattern for one server would also exclude a sibling server.
	const dotted = tool("mcp__a.b__search", "/ext/mcp/index.ts");
	const sibling = tool("mcp__axb__search", "/ext/mcp/index.ts");

	assert.throws(
		() =>
			resolveToolSelection({
				requested: ["mcp__a.b__search"],
				allTools: [dotted],
				trusted: true,
				disallowedTools: ["mcp__a.b__*"],
			}),
		/disallowed_tools pattern "mcp__a\.b__\*"/,
	);

	assert.deepEqual(
		resolveToolSelection({
			requested: ["mcp__axb__search"],
			allTools: [sibling],
			trusted: true,
			disallowedTools: ["mcp__a.b__*"],
		}).extensionPaths,
		["/ext/mcp/index.ts"],
		"the dot is escaped, so a different character does not match",
	);
});

test("a non-matching disallowed_tools pattern leaves the request alone", () => {
	const mcp = tool("mcp__srv__tool", "/ext/mcp/index.ts");
	const selection = resolveToolSelection({
		requested: ["mcp__srv__tool"],
		allTools: [mcp],
		trusted: true,
		disallowedTools: ["mcp__srv__other", "mcp__srv__*_suffix"],
	});

	assert.deepEqual(selection.extensionPaths, ["/ext/mcp/index.ts"]);
});

test("PI_SUBAGENT_EXCLUDED_TOOLS rejects a requested tool like ask_user does", () => {
	const renamed = tool("renamed_ask_user", "/ext/ask/index.ts");

	withEnv(" renamed_ask_user ", () => {
		assert.throws(
			() => resolveToolSelection({ requested: ["renamed_ask_user"], allTools: [renamed], trusted: true }),
			/PI_SUBAGENT_EXCLUDED_TOOLS/,
		);
	});

	// Restored: the same name is an ordinary extension tool again.
	assert.deepEqual(
		resolveToolSelection({ requested: ["renamed_ask_user"], allTools: [renamed], trusted: true }).extensionPaths,
		["/ext/ask/index.ts"],
	);
});

test("PI_SUBAGENT_EXCLUDED_TOOLS also rejects a definition's own tool", () => {
	const renamed = tool("renamed_ask_user", "/ext/ask/index.ts");

	withEnv("renamed_ask_user", () => {
		assert.throws(
			() =>
				resolveToolSelection({
					requested: [],
					allTools: [renamed],
					trusted: true,
					definitionTools: ["renamed_ask_user"],
					loadDefinitionTools: true,
				}),
			/PI_SUBAGENT_EXCLUDED_TOOLS/,
		);
	});
});
