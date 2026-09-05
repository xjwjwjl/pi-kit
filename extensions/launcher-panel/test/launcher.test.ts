import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { findGitWorkspace } from "../src/git.ts";
import { extensionCommandOptions } from "../src/launcher/commands.ts";
import { LauncherRegistry } from "../src/launcher/registry.ts";
import type { PanelOptionContext } from "../src/launcher/types.ts";

test("findGitWorkspace detects a repo root with .git directory", () => {
	const root = mkdtempSync(join(tmpdir(), "launcher-panel-"));
	try {
		mkdirSync(join(root, ".git"));
		const nested = join(root, "a", "b");
		mkdirSync(nested, { recursive: true });

		const fromRoot = findGitWorkspace(root);
		assert.ok(fromRoot);
		assert.equal(fromRoot.root, root);
		assert.equal(fromRoot.isLinkedWorktree, false);

		// Detection walks up from nested directories.
		const fromNested = findGitWorkspace(nested);
		assert.ok(fromNested);
		assert.equal(fromNested.root, root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("findGitWorkspace recognizes linked worktrees (.git file)", () => {
	const root = mkdtempSync(join(tmpdir(), "launcher-panel-"));
	try {
		writeFileSync(join(root, ".git"), "gitdir: /somewhere/.git/worktrees/x");
		const info = findGitWorkspace(root);
		assert.ok(info);
		assert.equal(info.isLinkedWorktree, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("findGitWorkspace returns null outside any git workspace", () => {
	// mkdtemp under os tmpdir: assume no .git above it.
	const root = mkdtempSync(join(tmpdir(), "launcher-panel-nogit-"));
	try {
		assert.equal(findGitWorkspace(root), null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

const fakePanelCtx = (workspaceRoot: string | null = null): PanelOptionContext =>
	({ ctx: {} as never, workspaceRoot }) as PanelOptionContext;

test("LauncherRegistry registers features and resolves their options", async () => {
	const registry = new LauncherRegistry();
	const noop = () => {};

	registry.register({ id: "f1", options: () => [{ id: "a", label: "A", execute: noop }] });
	registry.register({ id: "f2", options: async () => [{ id: "b", label: "B", execute: noop }] });
	assert.deepEqual(registry.list().map((f) => f.id), ["f1", "f2"]);
	assert.deepEqual((await registry.resolveOptions(fakePanelCtx())).map((o) => o.id), ["a", "b"]);

	// Re-registering the same id replaces without duplicating.
	registry.register({ id: "f1", options: () => [{ id: "a2", label: "A2", execute: noop }] });
	assert.deepEqual((await registry.resolveOptions(fakePanelCtx())).map((o) => o.id), ["a2", "b"]);
	const replaced = registry.get("f1")?.options(fakePanelCtx());
	assert.ok(Array.isArray(replaced));
	assert.equal(replaced[0]!.id, "a2");

	assert.equal(registry.unregister("f1"), true);
	assert.equal(registry.unregister("missing"), false);
	assert.deepEqual((await registry.resolveOptions(fakePanelCtx())).map((o) => o.id), ["b"]);
});

test("resolveOptions isolates failing features and reports them via onError", async () => {
	const registry = new LauncherRegistry();
	registry.register({
		id: "broken",
		options: () => {
			throw new Error("boom");
		},
	});
	registry.register({ id: "ok", options: () => [{ id: "good", label: "Good", execute: () => {} }] });

	const failures: string[] = [];
	const options = await registry.resolveOptions(fakePanelCtx(), (feature, error) => {
		failures.push(`${feature.id}:${(error as Error).message}`);
	});

	// The broken feature is skipped, the healthy one still resolves.
	assert.deepEqual(options.map((o) => o.id), ["good"]);
	assert.deepEqual(failures, ["broken:boom"]);
});

test("resolveOptions evaluates options fresh per call (dynamic features)", async () => {
	const registry = new LauncherRegistry();
	let calls = 0;
	registry.register({
		id: "dynamic",
		options: (panelCtx) => {
			calls += 1;
			return [{ id: `opt-${calls}`, label: panelCtx.workspaceRoot ?? "none", execute: () => {} }];
		},
	});

	const first = await registry.resolveOptions(fakePanelCtx("/repo"));
	const second = await registry.resolveOptions(fakePanelCtx(null));
	assert.deepEqual(first.map((o) => o.id), ["opt-1"]);
	assert.equal(first[0]!.label, "/repo");
	assert.deepEqual(second.map((o) => o.id), ["opt-2"]);
	assert.equal(second[0]!.label, "none");
});

test("extensionCommandOptions maps extension commands, skips other sources and excludes names", () => {
	let draft = "";
	const panelCtx = {
		ctx: {
			ui: {
				setEditorText: (text: string) => {
					draft = text;
				},
			},
		},
		workspaceRoot: null,
	} as never;

	const options = extensionCommandOptions(
		[
			{ name: "launcher", description: "Open the launcher panel", source: "extension", sourceInfo: {} },
			{ name: "token-pulse", description: "Token stats", source: "extension", sourceInfo: {} },
			{ name: "some-skill", description: "From a skill", source: "skill", sourceInfo: {} },
		] as never,
		new Set(["launcher"]),
	);

	assert.deepEqual(options.map((o) => o.id), ["command.token-pulse"]);
	assert.equal(options[0]!.label, "/token-pulse");
	assert.equal(options[0]!.description, "Token stats \u00b7 prefills the editor");

	// Executing prefills the editor (pi has no programmatic command dispatch).
	options[0]!.execute(panelCtx);
	assert.equal(draft, "/token-pulse ");
});

// ---------------------------------------------------------------------------
// UI-level tests. The pi runtime packages (@earendil-works/*) are provided
// by pi itself and are not installed here; the hooks in test/pi-loader.ts
// redirect them to local stubs (test/stubs/). The hooks must be registered
// before any panel module is imported below.
// ---------------------------------------------------------------------------

register("./pi-loader.ts", import.meta.url);

const { showLauncherPanel, openLauncher, runOption, resetOverlaySupport } = await import("../src/launcher/show.ts");
const { cappedWidth, toSelectItem } = await import("../src/launcher/component.ts");
const launcherPanel = (await import("../index.ts")).default;

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

interface PanelHarness {
	panelCtx: PanelOptionContext;
	notifications: Array<{ message: string; level?: string }>;
	customCalls: unknown[];
	renders: string[][];
	rendered: () => string[];
	editorTexts: string[];
}

/**
 * Build a PanelOptionContext whose ui.custom renders the panel against the
 * fake TUI and then drives it: `drive(comp)` receives the rendered component
 * and typically presses "1" (confirm first row) or "\u001b" (cancel).
 */
const harness = (workspaceRoot: string | null, drive: (comp: any) => void): PanelHarness => {
	const notifications: Array<{ message: string; level?: string }> = [];
	const customCalls: unknown[] = [];
	const renders: string[][] = [];
	const editorTexts: string[] = [];
	const panelCtx = {
		ctx: {
			mode: "tui",
			hasUI: true,
			cwd: "/nowhere",
			ui: {
				notify: (message: string, level?: string) => {
					notifications.push({ message, level });
				},
				setEditorText: (text: string) => {
					editorTexts.push(text);
				},
				custom: (factory: any, opts?: any) =>
					new Promise((resolve) => {
						customCalls.push(opts);
						const comp = factory({ requestRender: () => {} }, plainTheme, {}, resolve);
						renders.push(comp.render(80));
						drive(comp);
					}),
			},
		},
		workspaceRoot,
	} as never as PanelOptionContext;
	return {
		panelCtx,
		notifications,
		customCalls,
		renders,
		rendered: () => renders[renders.length - 1] ?? [],
		editorTexts,
	};
};

test("cappedWidth clamps between the minimum and the preferred width", () => {
	assert.equal(cappedWidth(120), 64);
	assert.equal(cappedWidth(40), 40);
	assert.equal(cappedWidth(5), 20); // never narrower than 20 columns
	assert.equal(cappedWidth(120, 100), 100);
});

test("toSelectItem joins shortcut and description", () => {
	const noop = () => {};
	assert.deepEqual(
		toSelectItem({ id: "a", label: "A", shortcut: "ctrl+w", description: "Do it", execute: noop }),
		{ value: "a", label: "A", description: "ctrl+w \u00b7 Do it" },
	);
	assert.deepEqual(toSelectItem({ id: "b", label: "B", execute: noop }), { value: "b", label: "B" });
});

test("runOption reports a throwing execute() instead of rejecting", async () => {
	const { panelCtx, notifications } = harness(null, () => {});
	await runOption(
		{
			id: "x",
			label: "Explode",
			execute: () => {
				throw new Error("kaboom");
			},
		},
		panelCtx,
	);
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0]!.level, "error");
	assert.ok(notifications[0]!.message.includes("Explode"));
	assert.ok(notifications[0]!.message.includes("kaboom"));
});

test("openLauncher shows feature options before extra options and runs the confirmed one", async () => {
	const executed: string[] = [];
	const registry = new LauncherRegistry();
	registry.register({
		id: "feat",
		options: () => [
			{
				id: "feat.one",
				label: "Feature One",
				execute: () => {
					executed.push("feat.one");
				},
			},
		],
	});
	const { panelCtx, rendered } = harness(null, (comp) => comp.handleInput("1"));

	await openLauncher(panelCtx.ctx, registry, null, () => [
		{
			id: "command.extra",
			label: "/extra",
			execute: () => {
				executed.push("extra");
			},
		},
	]);

	// Feature options come first, extras after; the confirmed row executed.
	// (Rows carry panel padding, so match by substring and compare positions.)
	const lines = rendered();
	const featureIdx = lines.findIndex((line) => line.includes("Feature One"));
	const extraIdx = lines.findIndex((line) => line.includes("/extra"));
	assert.ok(featureIdx >= 0, "feature row rendered");
	assert.ok(extraIdx > featureIdx, "extra row renders after the feature row");
	assert.deepEqual(executed, ["feat.one"]);
});

test("openLauncher skips failing option sources, notifies, and still opens the panel", async () => {
	const registry = new LauncherRegistry();
	registry.register({
		id: "broken",
		options: () => {
			throw new Error("feature boom");
		},
	});
	const { panelCtx, notifications, rendered } = harness(null, (comp) => comp.handleInput("\u001b"));

	await openLauncher(panelCtx.ctx, registry, null, () => {
		throw new Error("extra boom");
	});

	assert.deepEqual(
		notifications.map((n) => `${n.level}:${n.message}`),
		[
			'error:Feature "broken" failed to provide options: feature boom',
			"error:Extra option source failed: extra boom",
		],
	);
	// Panel still opens, with the disabled empty-placeholder row.
	assert.ok(rendered().some((line) => line.includes("No options available")));
});

test("openLauncher honors title/subtitle overrides", async () => {
	const registry = new LauncherRegistry();
	const { panelCtx, rendered } = harness(null, (comp) => comp.handleInput("\u001b"));
	await openLauncher(panelCtx.ctx, registry, null, () => [], {
		title: "Custom Title",
		subtitle: "Custom Subtitle",
	});
	const lines = rendered();
	assert.ok(lines.some((line) => line.includes("Custom Title")));
	assert.ok(lines.some((line) => line.includes("Custom Subtitle")));
});

test("showLauncherPanel renders a disabled placeholder when there are no options", async () => {
	const { panelCtx, rendered } = harness(null, (comp) => comp.handleInput("\u001b"));
	const selected = await showLauncherPanel(panelCtx.ctx, { title: "Empty", options: [] });
	assert.equal(selected, null);
	assert.ok(rendered().some((line) => line.includes("No options available")));
});

test("showLauncherPanel falls back to editor mode when overlay is unsupported", async () => {
	resetOverlaySupport();
	let attempts = 0;
	const panelCtx = {
		ctx: {
			mode: "tui",
			hasUI: true,
			ui: {
				notify: () => {},
				custom: (factory: any, opts?: any) => {
					attempts += 1;
					if (attempts === 1) {
						assert.ok(opts?.overlay); // first attempt is the overlay variant
						return Promise.reject(new Error("overlay unsupported"));
					}
					return new Promise((resolve) => {
						const comp = factory({ requestRender: () => {} }, plainTheme, {}, resolve);
						comp.handleInput("1");
					});
				},
			},
		},
		workspaceRoot: null,
	} as never as PanelOptionContext;

	const selected = await showLauncherPanel(panelCtx.ctx, {
		title: "T",
		options: [{ id: "only", label: "Only", execute: () => {} }],
	});
	assert.equal(attempts, 2);
	assert.equal(selected?.id, "only");
});

test("showLauncherPanel surfaces both errors when overlay and fallback fail", async () => {
	resetOverlaySupport();
	const panelCtx = {
		ctx: {
			mode: "tui",
			hasUI: true,
			ui: { notify: () => {}, custom: () => Promise.reject(new Error("nope")) },
		},
		workspaceRoot: null,
	} as never as PanelOptionContext;

	await assert.rejects(
		showLauncherPanel(panelCtx.ctx, { title: "T", options: [{ id: "a", label: "A", execute: () => {} }] }),
		(error: Error) => error.message.includes("nope") && error.message.includes("overlay and fallback"),
	);
});

test("showLauncherPanel remembers overlay failure and skips the overlay afterwards", async () => {
	resetOverlaySupport();
	let overlayAttempts = 0;
	const panelCtx = {
		ctx: {
			mode: "tui",
			hasUI: true,
			ui: {
				notify: () => {},
				custom: (factory: any, opts?: any) => {
					if (opts?.overlay) {
						overlayAttempts += 1;
						return Promise.reject(new Error("no overlay"));
					}
					return new Promise((resolve) => {
						const comp = factory({ requestRender: () => {} }, plainTheme, {}, resolve);
						comp.handleInput("\u001b");
					});
				},
			},
		},
		workspaceRoot: null,
	} as never as PanelOptionContext;
	const config = { title: "T", options: [{ id: "a", label: "A", execute: () => {} }] };

	await showLauncherPanel(panelCtx.ctx, config);
	await showLauncherPanel(panelCtx.ctx, config);

	// Only the first open probes the overlay; the second goes straight to
	// the editor-replacement fallback.
	assert.equal(overlayAttempts, 1);
	resetOverlaySupport();
});

test("showLauncherPanel keeps the first of duplicate option ids and warns", async () => {
	const { panelCtx, notifications } = harness(null, (comp) => comp.handleInput("1"));
	const selected = await showLauncherPanel(panelCtx.ctx, {
		title: "T",
		options: [
			{ id: "dup", label: "First", execute: () => {} },
			{ id: "dup", label: "Second", execute: () => {} },
		],
	});
	assert.equal(selected?.label, "First");
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0]!.level, "warning");
	assert.ok(notifications[0]!.message.includes('"dup"'));
});

test("launcherPanel collapses extension commands into a sub-panel", async () => {
	// Main panel has only the collapsed entry; sub-panel: press "1".
	const h = harness(null, (comp) => comp.handleInput("1"));
	const commandHandlers: Record<string, (args: string, ctx: any) => Promise<void>> = {};
	const pi = {
		getCommands: () => [
			{ name: "launcher", description: "Open the launcher panel", source: "extension" },
			{ name: "token-pulse", description: "Token stats", source: "extension" },
		],
		registerCommand: (name: string, def: any) => {
			commandHandlers[name] = def.handler;
		},
		registerShortcut: () => {},
		on: () => {},
	} as never;
	launcherPanel(pi);

	await commandHandlers["launcher"]!("", h.panelCtx.ctx);

	// Main panel: collapsed entry only; raw command hidden until the sub-panel.
	const main = h.renders[0]!;
	assert.ok(main.some((line) => line.includes("Extension commands")));
	assert.ok(!main.some((line) => line.includes("/token-pulse")));

	// Sub-panel lists the actual command; confirming it prefills the editor.
	assert.ok(h.renders[1]!.some((line) => line.includes("/token-pulse")));
	assert.deepEqual(h.editorTexts, ["/token-pulse "]);
	assert.equal(h.customCalls.length, 2);
});

test("launcherPanel registers the /launcher command and no feature shortcuts", () => {
	const registeredCommands: string[] = [];
	const registeredShortcuts: string[] = [];
	const pi = {
		getCommands: () => [],
		registerCommand: (name: string) => {
			registeredCommands.push(name);
		},
		registerShortcut: (key: string) => {
			registeredShortcuts.push(key);
		},
		on: () => {},
	} as never;
	launcherPanel(pi);
	assert.deepEqual(registeredCommands, ["launcher"]);
	assert.deepEqual(registeredShortcuts, []);
});

test("session_start auto-opens only for startup inside a git workspace", async () => {
	const handlers: Record<string, (event: any, ctx: any) => Promise<void>> = {};
	const shortcutDefs: Array<{ key: string; handler: (ctx: any) => Promise<void> }> = [];
	const { panelCtx, customCalls } = harness(null, (comp) => comp.handleInput("\u001b"));

	const pi = {
		getCommands: () => [],
		registerCommand: () => {},
		registerShortcut: (key: string, def: any) => {
			shortcutDefs.push({ key, handler: def.handler });
		},
		on: (event: string, handler: any) => {
			(handlers as any)[event] = handler;
		},
	} as never;
	launcherPanel(pi);

	// No feature declares a global shortcut at this phase.
	assert.equal(shortcutDefs.length, 0);

	const gitDir = mkdtempSync(join(tmpdir(), "launcher-panel-auto-"));
	mkdirSync(join(gitDir, ".git"));
	const noGitDir = mkdtempSync(join(tmpdir(), "launcher-panel-nogit-auto-"));
	try {
		const baseCtx = { ...panelCtx.ctx, hasUI: true };

		// resume: never re-pops
		await handlers.session_start!({ reason: "resume" }, { ...baseCtx, cwd: gitDir });
		assert.equal(customCalls.length, 0);

		// startup inside a git workspace: auto-opens
		await handlers.session_start!({ reason: "startup" }, { ...baseCtx, cwd: gitDir });
		assert.equal(customCalls.length, 1);

		// startup outside a git workspace: stays silent
		await handlers.session_start!({ reason: "startup" }, { ...baseCtx, cwd: noGitDir });
		assert.equal(customCalls.length, 1);
	} finally {
		rmSync(gitDir, { recursive: true, force: true });
		rmSync(noGitDir, { recursive: true, force: true });
	}
});
