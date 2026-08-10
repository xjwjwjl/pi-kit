import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	SessionTurnsComponent,
	type OutlineAction,
	type OutlineState,
} from "./src/session-turns-component.ts";

export {
	buildTurnForest,
	connectorGlyph,
	entryRows,
	filterTurnForest,
	flattenTurnForest,
	formatSessionRollup,
	formatTurnInsight,
	matchesTurnFilter,
	matchesTurnQuery,
	navigateTargetId,
	parseTurnQuery,
	rowPrefix,
	sessionRollup,
	turnStatusGlyphs,
	type EntryRow,
	type OutlineFilterMode,
	type SessionRollup,
	type TurnInsight,
	type TurnQueryClause,
	type TurnRow,
	type TurnTreeNode,
} from "./src/outline-model.ts";

async function chooseSummaryOptions(ctx: ExtensionCommandContext): Promise<
	| { summarize: false }
	| { summarize: true; customInstructions?: string }
	| undefined
> {
	const choice = await ctx.ui.select("Summarize branch?", ["No summary", "Summarize", "Summarize with custom prompt"]);
	if (!choice) return undefined;
	if (choice === "No summary") return { summarize: false };
	if (choice === "Summarize") return { summarize: true };

	const customInstructions = await ctx.ui.editor("Custom summarization instructions", "");
	return customInstructions === undefined ? undefined : { summarize: true, customInstructions };
}

function activeEntryIds(ctx: ExtensionCommandContext): Set<string> {
	return new Set(ctx.sessionManager.getBranch().map((entry) => entry.id));
}

async function showOutline(pi: ExtensionAPI, ctx: ExtensionCommandContext, initial: OutlineState = {}): Promise<void> {
	let state = initial;
	while (true) {
		const tree = ctx.sessionManager.getTree();
		if (tree.length === 0) {
			ctx.ui.notify("No user messages to browse in this session.", "info");
			return;
		}

		const action = await ctx.ui.custom<OutlineAction | undefined>((tui, theme, keybindings, done) =>
			new SessionTurnsComponent(tui, theme, keybindings, tree, activeEntryIds(ctx), done, state),
		);
		if (!action) return;

		if (action.type === "label") {
			const label = await ctx.ui.editor("Edit label:", ctx.sessionManager.getLabel(action.targetId) ?? "");
			if (label !== undefined) pi.setLabel(action.targetId, label.trim() || undefined);
			state = action.state;
			continue;
		}

		if (action.targetId === ctx.sessionManager.getLeafId()) {
			ctx.ui.notify("Already at this node.", "info");
			return;
		}

		const options = await chooseSummaryOptions(ctx);
		if (!options) {
			state = action.state;
			continue;
		}

		if (options.summarize) ctx.ui.setStatus("outline", ctx.ui.theme.fg("accent", "Generating branch summary…"));
		try {
			const result = await ctx.navigateTree(action.targetId, options);
			if (result.cancelled) ctx.ui.notify("Navigation cancelled.", "info");
			else ctx.ui.notify("Jumped to the selected node.", "info");
		} finally {
			ctx.ui.setStatus("outline", undefined);
		}
		return;
	}
}

export default function outlineExtension(pi: ExtensionAPI): void {
	pi.registerCommand("outline", {
		description: "Browse user turns with active-path and turn activity insights",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/outline is only available in interactive TUI mode.", "error");
				return;
			}
			await ctx.waitForIdle();
			await showOutline(pi, ctx);
		},
	});
}
