import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings, matchesKey, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { type CompactToolUiOptionsRef, INLINE_DIFF_NEVER } from "../settings/options.js";
import {
	type CompactToolUiField,
	type CompactToolUiLayers,
	type CompactToolUiScope,
	type CompactToolUiSettings,
	type CompactToolUiSettingsPatch,
	effectiveCompactToolUiSettings,
	globalSettingsPath,
	layerCompactToolUiSettings,
	loadCompactToolUiLayers,
	projectSettingsPath,
	saveCompactToolUiSettings,
} from "../settings/compact-tool-ui.js";

/** `never` is the UI label for the `INLINE_DIFF_NEVER` sentinel; the raw `-1` never reaches the UI. */
const INLINE_DIFF_MAX_LINE_VALUES = ["0", "16", "32", "64", "128"];
const SCOPE_VALUES: CompactToolUiScope[] = ["global", "project"];

/** Value that clears a key in the current layer so it falls back to the layer below. */
const CLEAR_LABEL: Record<CompactToolUiScope, string> = { global: "unset", project: "inherit" };

type FieldSpec = {
	id: CompactToolUiField;
	label: string;
	description: string;
	values: string[];
	read: (layer: CompactToolUiSettings) => string | undefined;
	/** `undefined` clears the key from that layer. */
	write: (layer: CompactToolUiSettings, value: string | undefined) => void;
};

function setEditField(layer: CompactToolUiSettings, patch: Record<string, unknown>) {
	layer.edit = { ...(layer.edit ?? {}), ...patch };
}

function clearEditField(layer: CompactToolUiSettings, key: string) {
	if (!layer.edit) return;
	const next = { ...layer.edit } as Record<string, unknown>;
	delete next[key];
	layer.edit = Object.keys(next).length > 0 ? (next as CompactToolUiSettings["edit"]) : undefined;
}

const FIELDS: FieldSpec[] = [
	{
		id: "renderShell",
		label: "Tool render shell",
		description: "Use self for borderless compact rows, or default for pi's original boxed shell.",
		values: ["self", "default"],
		read: (layer) => layer.renderShell,
		write: (layer, value) => {
			if (value === "self" || value === "default") layer.renderShell = value;
			else delete layer.renderShell;
		},
	},
	{
		id: "inlineDiffMaxLines",
		label: "Edit inline diff max lines",
		description: "Show edit diffs inline up to this many lines; never hides them, 0 is unlimited.",
		values: ["never", ...INLINE_DIFF_MAX_LINE_VALUES],
		read: (layer) => {
			const value = layer.edit?.inlineDiffMaxLines;
			if (value === undefined) return undefined;
			return value === INLINE_DIFF_NEVER ? "never" : String(value);
		},
		write: (layer, value) => {
			if (value === "never") {
				setEditField(layer, { inlineDiffMaxLines: INLINE_DIFF_NEVER });
				return;
			}
			const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
			if (Number.isFinite(parsed) && parsed >= 0) setEditField(layer, { inlineDiffMaxLines: parsed });
			else clearEditField(layer, "inlineDiffMaxLines");
		},
	},
];

function fieldItemSpec(
	field: FieldSpec,
	layers: CompactToolUiLayers,
	lastSaved: CompactToolUiLayers,
	scope: CompactToolUiScope,
	pending: boolean,
): SettingItem {
	const clearLabel = CLEAR_LABEL[scope];
	const current = field.read(layers[scope]);
	const currentValue = current ?? clearLabel;
	// A hand-written value outside the preset list stays reachable per row, and the clear label is
	// deduped so a value literally named like it (renderShell's "default") cannot collide.
	const values = [...new Set([clearLabel, ...(current && !field.values.includes(current) ? [current] : []), ...field.values])];
	const fallback = scope === "project" ? "Choose inherit to fall back to the global value." : "Choose unset to fall back to the built-in default.";
	const effective = effectiveCompactToolUiSettings(layerCompactToolUiSettings(lastSaved));
	const source = field.read(lastSaved.project) !== undefined ? "project" : field.read(lastSaved.global) !== undefined ? "global" : "built-in";
	const status = [
		`Effective: ${field.read(effective)} (source: ${source}).`,
		pending ? "Current edit is pending save." : "",
		scope === "global" && source === "project" ? "This layer is overridden by project." : "",
	].filter(Boolean).join(" ");
	const error = layers.errors?.[scope];
	return {
		id: field.id,
		label: field.label,
		description: `${field.description} ${fallback} ${status}${error ? ` Unavailable: ${error.path}: ${error.message}. Fix the file and reopen this panel to edit.` : ""}`,
		currentValue: error ? "unavailable" : currentValue,
		values: error ? undefined : values,
	};
}

function scopeItemSpec(scope: CompactToolUiScope, cwd: string): SettingItem {
	const path = scope === "project" ? projectSettingsPath(cwd) : globalSettingsPath();
	return {
		id: "scope",
		label: "Settings scope",
		description: `Edit the ${scope} layer: ${path}. Project values override global ones per field.`,
		currentValue: scope,
		values: [...SCOPE_VALUES],
	};
}

export async function openCompactToolUiSettings(optionsRef: CompactToolUiOptionsRef, ctx: ExtensionCommandContext) {
	if (ctx.mode !== "tui") return;

	const cwd = ctx.cwd;
	const projectTrusted = ctx.isProjectTrusted();
	const layers: CompactToolUiLayers = await loadCompactToolUiLayers(cwd, projectTrusted);
	let scope: CompactToolUiScope = "global";
	const lastSaved = structuredClone(layers);
	const dirtyFields: Record<CompactToolUiScope, Set<CompactToolUiField>> = { global: new Set(), project: new Set() };
	const inFlight: Record<CompactToolUiScope, Set<CompactToolUiField>> = { global: new Set(), project: new Set() };
	optionsRef.current = effectiveCompactToolUiSettings(layerCompactToolUiSettings(lastSaved));
	for (const target of SCOPE_VALUES) {
		const error = layers.errors?.[target];
		if (error) ctx.ui.notify(`Failed to load compact-tool-ui ${target} settings (${error.path}): ${error.message}`, "error");
	}

	// The list is a live view of the layer selected by the scope row, so switching scope rebuilds
	// every row from that layer instead of showing the merged result.
	// The cursor is mirrored here so the shortcuts can act on the selected row.
	let cursor = 0;

	const buildItems = (): SettingItem[] => {
		const items: SettingItem[] = [];
		if (projectTrusted) {
			items.push(scopeItemSpec(scope, cwd));
		} else {
			items.push({
				id: "scope",
				label: "Settings scope",
				description: "Project settings are ignored because this folder is not trusted.",
				currentValue: "global",
				values: ["global"],
			});
		}
		for (const field of FIELDS) {
			items.push(fieldItemSpec(field, layers, lastSaved, scope, dirtyFields[scope].has(field.id) || inFlight[scope].has(field.id)));
		}
		return items;
	};

	await ctx.ui.custom((tui, theme, _kb, done) => {
		const items = buildItems();
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("Compact Tool UI Settings")), 1, 1));
		container.addChild(new Text(theme.fg("dim", "↑↓ move · ←→ change · Enter next · Tab switches scope · Backspace clears this layer"), 1, 0));

		// SettingsList keeps the array by reference, so refreshing rows means mutating these objects.
		const refresh = () => {
			for (const spec of buildItems()) {
				const item = items.find((candidate) => candidate.id === spec.id);
				if (!item) continue;
				item.label = spec.label;
				item.description = spec.description;
				item.currentValue = spec.currentValue;
				item.values = spec.values;
			}
			if (cursor > items.length - 1) cursor = Math.max(0, items.length - 1);
			container.invalidate();
			tui.requestRender();
		};

		/**
		 * Saves are coalesced and serialized: a burst of Enter presses must not run overlapping
		 * writes, and a failure must restore the last state that actually reached disk.
		 */
		const dirtyScopes = new Set<CompactToolUiScope>();
		let saving = false;

		const flush = async () => {
			if (saving) return;
			saving = true;
			try {
				for (const target of dirtyScopes) {
					dirtyScopes.delete(target);
					// Freeze only this batch's edited fields before yielding. Later edits form a new
					// batch, while untouched fields are refreshed from the committed disk layer.
					const patch: CompactToolUiSettingsPatch = {};
					for (const field of dirtyFields[target]) {
						if (field === "renderShell") patch.renderShell = layers[target].renderShell ?? null;
						else patch.edit = { inlineDiffMaxLines: layers[target].edit?.inlineDiffMaxLines ?? null };
					}
					inFlight[target] = new Set(dirtyFields[target]);
					dirtyFields[target].clear();
					try {
						const committed = await saveCompactToolUiSettings(target, cwd, structuredClone(patch));
						lastSaved[target] = structuredClone(committed);
						const pending = layers[target];
						layers[target] = structuredClone(committed);
						for (const field of FIELDS) {
							if (dirtyFields[target].has(field.id)) field.write(layers[target], field.read(pending));
						}
						inFlight[target].clear();
						optionsRef.current = effectiveCompactToolUiSettings(layerCompactToolUiSettings(lastSaved));
						refresh();
						ctx.ui.notify(`Saved compact-tool-ui settings to ${target === "project" ? "project" : "global"} settings`, "info");
					} catch (error) {
						// Discard this scope's unsaved queue and restore its last known committed
						// snapshot. Other scopes still get their pending save.
						dirtyScopes.delete(target);
						dirtyFields[target].clear();
						inFlight[target].clear();
						layers[target] = structuredClone(lastSaved[target]);
						optionsRef.current = effectiveCompactToolUiSettings(layerCompactToolUiSettings(lastSaved));
						refresh();
						const message = error instanceof Error ? error.message : String(error);
						ctx.ui.notify(`Failed to save compact-tool-ui settings: ${message}`, "error");
					}
				}
			} finally {
				saving = false;
			}
		};

		const selectRow = (id: string, newValue: string) => {
			if (id === "scope") {
				scope = projectTrusted && newValue === "project" ? "project" : "global";
				refresh();
				return;
			}
			const field = FIELDS.find((candidate) => candidate.id === id);
			if (!field || layers.errors?.[scope]) return;
			field.write(layers[scope], newValue === CLEAR_LABEL[scope] ? undefined : newValue);
			dirtyFields[scope].add(field.id);
			dirtyScopes.add(scope);
			refresh();
			void flush();
		};

		const settingsList = new SettingsList(
			items,
			Math.min(items.length + 4, 15),
			getSettingsListTheme(),
			selectRow,
			() => done(undefined),
			// No fuzzy search: three rows do not need it, and the extra input line steals the keys
			// used by the shortcuts below.
		);
		container.addChild(settingsList);

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				if (matchesKey(data, "tab") && projectTrusted) {
					scope = scope === "project" ? "global" : "project";
					refresh();
					return;
				}
				// Movement is delegated, but the wrap-around is mirrored so the shortcuts below act
				// on the row the list has selected.
				const keys = getKeybindings();
				const up = keys.matches(data, "tui.select.up");
				const down = keys.matches(data, "tui.select.down");
				if (items.length > 0 && (up || down)) {
					if (up) cursor = cursor === 0 ? items.length - 1 : cursor - 1;
					else cursor = cursor === items.length - 1 ? 0 : cursor + 1;
					settingsList.handleInput?.(data);
					tui.requestRender();
					return;
				}
				const row = items[cursor];
				const values = row?.values;
				if (row && values && values.length > 0 && (matchesKey(data, "left") || matchesKey(data, "right"))) {
					const step = matchesKey(data, "right") ? 1 : -1;
					const index = values.indexOf(row.currentValue ?? "");
					const next = values[(((index < 0 ? 0 : index) + step) % values.length + values.length) % values.length];
					if (next !== undefined) selectRow(row.id, next);
					return;
				}
				if (row && row.id !== "scope" && (matchesKey(data, "backspace") || matchesKey(data, "delete"))) {
					selectRow(row.id, CLEAR_LABEL[scope]);
					return;
				}
				settingsList.handleInput?.(data);
				tui.requestRender();
			},
		};
	});
}
