import assert from "node:assert/strict";
import os from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { getCapabilities, setCapabilities } from "@earendil-works/pi-tui";
import { linkPath, resolveToolPathForLink } from "../tui-utils.js";

test("path hyperlinks use Pi-compatible @ and ~ path resolution", () => {
	const cwd = resolve(process.cwd(), "fixture");
	assert.equal(
		resolveToolPathForLink("@extensions/compact-tool-ui/index.ts", cwd),
		resolve(cwd, "extensions/compact-tool-ui/index.ts"),
	);
	assert.equal(resolveToolPathForLink("~/notes/todo.md", cwd), resolve(os.homedir(), "notes/todo.md"));

	const previous = getCapabilities();
	setCapabilities({ ...previous, hyperlinks: true });
	try {
		const target = resolve(cwd, "extensions/compact-tool-ui/index.ts");
		assert.equal(
			linkPath("index.ts", "@extensions/compact-tool-ui/index.ts", cwd),
			`\x1b]8;;${pathToFileURL(target).href}\x1b\\index.ts\x1b]8;;\x1b\\`,
		);
	} finally {
		setCapabilities(previous);
	}
});
