import assert from "node:assert/strict";
import test from "node:test";
import { hyperlink, visibleWidth } from "@earendil-works/pi-tui";
import { CompactToolRow } from "../components/compact-tool-row.js";

test("CompactToolRow truncation closes OSC 8 hyperlinks", () => {
	const row = new CompactToolRow();
	row.setParts("", hyperlink("very-long-linked-path", "file:///tmp/example"));

	const line = row.render(10)[0] ?? "";
	assert.equal(visibleWidth(line), 10);
	assert.match(line, /…\x1b]8;;\x1b\\$/);
});
