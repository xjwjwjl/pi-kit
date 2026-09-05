import { DynamicBorder, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	SelectList,
	Spacer,
	Text,
	type Component,
	type SelectItem,
	type SelectListLayoutOptions,
	type SelectListTheme,
} from "@earendil-works/pi-tui";
import { formatCreditChoice } from "./reset-format.ts";
import type { ResetCredit } from "./types.ts";

export type ResetPickerResult = { creditId: string } | { cancelled: true };

/**
 * Two-stage picker: choose one reset credit, then confirm consumption.
 * - Stage 1: SelectList over available credits (↑↓/1-9 quick select, enter choose)
 * - Stage 2: Confirm panel showing the selected credit with an explicit warning
 *
 * The whole subtree is rebuilt on stage change and invalidate; only the
 * SelectList handleInput is forwarded. Follows pi's official selection-dialog
 * conventions (DynamicBorder accent frame, no custom panel background).
 */
export class ResetCreditPicker extends Container {
	private readonly credits: ResetCredit[];
	private readonly now: Date;
	private readonly theme: Theme;
	private readonly onDone: (result: ResetPickerResult) => void;
	private selectedIndex: number | null = null;
	private stage: "select" | "confirm" = "select";
	private selectList: SelectList | undefined;

	constructor(
		credits: ResetCredit[],
		now: Date,
		theme: Theme,
		_keybindings: KeybindingsManager,
		onDone: (result: ResetPickerResult) => void,
	) {
		super();
		this.credits = credits;
		this.now = now;
		this.theme = theme;
		this.onDone = onDone;
		this.rebuild();
	}

	handleInput(data: string): void {
		// Select stage: forward everything to SelectList; quick-select digits too.
		if (this.stage === "select") {
			if (/^[1-9]$/.test(data)) {
				const index = Number(data) - 1;
				if (this.credits[index]) {
					this.selectList?.setSelectedIndex(index);
					this.selectList?.onSelect?.(this.toSelectItem(index));
				}
				return;
			}
			this.selectList?.handleInput(data);
			return;
		}

		// Confirm stage: enter confirms, escape returns to selection.
		if (data === "enter") {
			const index = this.selectedIndex ?? 0;
			const credit = this.credits[index];
			if (credit) this.onDone({ creditId: credit.id });
		} else if (data === "escape") {
			this.stage = "select";
			this.selectedIndex = null;
			this.rebuild();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	/** Rebuild the entire subtree from scratch (title, list/confirm, borders). */
	private rebuild(): void {
		// Container keeps children; remove all children one by one.
		for (const child of [...this.children]) {
			this.removeChild(child);
		}

		this.addChild(new DynamicBorder((s: string) => this.theme.fg("accent", s)));
		this.addChild(new Text(
			this.theme.fg("accent", this.theme.bold(
				this.stage === "select"
					? "Codex reset credits"
					: "Confirm reset credit",
			)),
			1,
			0,
		));

		if (this.stage === "confirm") {
			this.addChild(this.buildConfirm());
		} else {
			this.addChild(this.buildSelect());
		}

		this.addChild(new DynamicBorder((s: string) => this.theme.fg("accent", s)));
	}

	private buildSelect(): Component {
		const items = this.credits.map((_, index) => this.toSelectItem(index));
		this.selectList = new SelectList(
			items,
			Math.min(Math.max(items.length, 1), 10),
			this.selectTheme(),
			this.selectLayout(),
		);
		this.selectList.onSelect = (item) => {
			const index = items.findIndex((it) => it.value === item.value);
			if (index >= 0 && this.credits[index]) {
				this.selectedIndex = index;
				this.stage = "confirm";
				this.rebuild();
			}
		};
		this.selectList.onCancel = () => this.onDone({ cancelled: true });

		const holder = new Container();
		holder.addChild(this.selectList);
		holder.addChild(new Spacer(1));
		holder.addChild(new Text(
			this.theme.fg("dim", "↑↓ select · 1-9 quick · enter use · esc cancel"),
			1,
			0,
		));
		return holder;
	}

	private buildConfirm(): Component {
		const index = this.selectedIndex ?? 0;
		const credit = this.credits[index];
		const holder = new Container();
		if (credit) {
			holder.addChild(new Text(
				this.theme.fg("accent", this.theme.bold(formatCreditChoice(credit, index, this.now))),
				1,
				0,
			));
			holder.addChild(new Spacer(1));
			holder.addChild(new Text(
				this.theme.fg("text", credit.title?.trim() || "Reset credit"),
				1,
				0,
			));
		}
		holder.addChild(new Spacer(1));
		holder.addChild(new Text(
			this.theme.fg("warning", "This action cannot be undone. The selected credit will be consumed."),
			1,
			0,
		));
		holder.addChild(new Spacer(1));
		holder.addChild(new Text(
			this.theme.fg("dim", "Enter consume · esc back"),
			1,
			0,
		));
		return holder;
	}

	private toSelectItem(index: number): SelectItem {
		const credit = this.credits[index]!;
		return {
			value: credit.id,
			// Show the full credit text in the label so no separate description column is needed.
			label: formatCreditChoice(credit, index, this.now),
		};
	}

	private selectTheme(): SelectListTheme {
		return {
			selectedPrefix: (t: string) => this.theme.fg("accent", t),
			selectedText: (t: string) => this.theme.fg("accent", t),
			description: (t: string) => this.theme.fg("muted", t),
			scrollInfo: (t: string) => this.theme.fg("muted", t),
			noMatch: (t: string) => this.theme.fg("muted", t),
		};
	}

	private selectLayout(): SelectListLayoutOptions {
		return {
			minPrimaryColumnWidth: 20,
			maxPrimaryColumnWidth: 80,
		};
	}
}
