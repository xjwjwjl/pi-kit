import type { Component } from "@earendil-works/pi-tui";
import { CompactToolRow, type CompactToolRowSuffixCandidate } from "./compact-tool-row.js";

/** Single-line header shared by expanded tool renderers. */
export class ExpandedToolHeader implements Component {
	private readonly row = new CompactToolRow();

	setParts(prefix: string, body: string, suffix = "", suffixCandidates: CompactToolRowSuffixCandidate[] = []) {
		this.row.setParts(prefix, body, suffix, suffixCandidates);
	}

	invalidate() {
		this.row.invalidate();
	}

	render(width: number): string[] {
		return this.row.render(width);
	}
}
