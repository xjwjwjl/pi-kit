import assert from "node:assert/strict";
import test from "node:test";
import {
	buildProjectGroups,
	cwdKey,
	defaultCollapsedProjects,
	flattenProjectGroups,
	projectRowKey,
} from "../src/session-tree.ts";
import type { GlobalSession } from "../src/types.ts";

function session(path: string, cwd: string, modified: string): GlobalSession {
	return {
		path,
		id: path,
		cwd,
		created: new Date(modified),
		modified: new Date(modified),
		messageCount: 1,
		firstPrompt: path,
		lastReply: "",
		allMessagesText: path,
		searchText: `${cwd} ${path}`.toLowerCase(),
	};
}

test("projects group by full cwd, sort by latest activity, and expand current plus recent", () => {
	const projects = buildProjectGroups([
		session("a-old", "D:/code/alpha", "2026-07-01T10:00:00.000Z"),
		session("a-new", "D:/code/alpha", "2026-07-03T10:00:00.000Z"),
		session("b", "D:/code/beta", "2026-07-04T10:00:00.000Z"),
		session("c", "D:/code/gamma", "2026-07-02T10:00:00.000Z"),
	], "D:\\code\\alpha");

	assert.deepEqual(projects.map((project) => project.cwd), ["D:/code/beta", "D:/code/alpha", "D:/code/gamma"]);
	assert.equal(projects.find((project) => project.cwd === "D:/code/alpha")?.isCurrent, true);
	const collapsed = defaultCollapsedProjects(projects);
	assert.equal(collapsed.has(cwdKey("D:/code/alpha")), false);
	assert.equal(collapsed.has(cwdKey("D:/code/beta")), false);
	assert.equal(collapsed.has(cwdKey("D:/code/gamma")), true);

	const rows = flattenProjectGroups(projects, collapsed);
	assert.deepEqual(rows.map((row) => row.key), [
		projectRowKey(cwdKey("D:/code/beta")),
		"session:b",
		projectRowKey(cwdKey("D:/code/alpha")),
		"session:a-new",
		"session:a-old",
		projectRowKey(cwdKey("D:/code/gamma")),
	]);
});

test("search projection forces matching project groups open without mutating collapsed state", () => {
	const projects = buildProjectGroups([
		session("a", "D:/code/alpha", "2026-07-01T10:00:00.000Z"),
		session("b", "D:/code/beta", "2026-07-02T10:00:00.000Z"),
	], "D:/code/alpha");
	const collapsed = new Set(projects.map((project) => project.key));

	const rows = flattenProjectGroups(projects, collapsed, true);
	assert.equal(rows.filter((row) => row.kind === "session").length, 2);
	assert.equal(collapsed.size, 2);
});
