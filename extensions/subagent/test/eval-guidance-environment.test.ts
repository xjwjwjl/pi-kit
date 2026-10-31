import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { createLsToolDefinition, createReadToolDefinition, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { createReadOnlyTools, type FixtureAccess } from "../scripts/eval-guidance/environment.ts";

const CWD = "/fixture";
function environment(entries: [string, string][] = [], cwd = CWD) {
	const accesses: FixtureAccess[] = [];
	const tools = createReadOnlyTools(cwd, new Map(entries), (entry) => accesses.push(entry));
	function run(name: "read" | "ls", args: Record<string, unknown> = {}, signal?: AbortSignal) {
		// A hostile execution context must not change the closure's fixture boundary.
		return tools.find((tool) => tool.name === name)!.execute("test", args, signal, undefined, { cwd: "/outside" } as never);
	}
	return { tools, accesses, run };
}

function text(result: Awaited<ReturnType<ToolDefinition["execute"]>>): string {
	assert.equal(result.content.length, 1);
	assert.equal(result.content[0].type, "text");
	assert.equal(typeof result.structuredContent, "string");
	assert.equal(result.structuredContent, result.content[0].type === "text" ? result.content[0].text : undefined);
	return result.structuredContent as string;
}

function code(expected: string) {
	return (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.equal((error as NodeJS.ErrnoException).code, expected);
		assert.match(error.message, new RegExp(`^${expected}:`));
		return true;
	};
}

test("exposes only read and ls, preserving SDK schemas and codemode-compatible strings", async () => {
	const env = environment([["photo.png", "plain fixture text"]]);
	assert.deepEqual(env.tools.map((tool) => tool.name), ["read", "ls"]);
	assert.deepEqual(env.tools[0].parameters, createReadToolDefinition(CWD).parameters);
	assert.deepEqual(env.tools[0].outputSchema, createReadToolDefinition(CWD).outputSchema);
	assert.deepEqual(env.tools[1].parameters, createLsToolDefinition(CWD).parameters);
	assert.match(env.tools[0].description, /评测夹具中的纯文本read/);
	assert.doesNotMatch(env.tools[0].description, /Supports text files and images/);
	for (const tool of env.tools) {
		const result = await env.run(tool.name as "read" | "ls", tool.name === "read" ? { path: "photo.png" } : {});
		assert.ok(Value.Check(tool.outputSchema!, result.structuredContent));
	}
	assert.equal(text(await env.run("read", { path: "photo.png" })), "plain fixture text");
});

test("takes a normalized immutable snapshot with implicit directories", async () => {
	const files = new Map([["./src\\nested//file.txt", "before"], ["top", "top"]]);
	const tools = createReadOnlyTools(CWD, files);
	files.set("./src\\nested//file.txt", "after");
	files.set("new", "new");
	files.delete("top");
	const read = (path: string) => tools[0].execute("x", { path }, undefined, undefined, {} as never);
	const ls = (path?: string) => tools[1].execute("x", { path }, undefined, undefined, {} as never);
	assert.equal(text(await read("src/nested/file.txt")), "before");
	assert.equal(text(await read("top")), "top");
	assert.equal(text(await ls()), "src/\ntop");
	assert.equal(text(await ls("./src/")), "nested/");
	await assert.rejects(read("new"), code("ENOENT"));
});

test("read honors exact 1-based offset/limit and continuation without native coercions", async () => {
	const { run, accesses } = environment([["lines", "one\ntwo\nthree\nfour"]]);
	assert.equal(text(await run("read", { path: "lines" })), "one\ntwo\nthree\nfour");
	assert.equal(text(await run("read", { path: "lines", offset: 2, limit: 2 })), "two\nthree\n\n[Showing lines 2-3 of 4. Use offset=4 to continue.]");
	assert.equal(text(await run("read", { path: "lines", offset: 4, limit: 50 })), "four");
	await assert.rejects(run("read", { path: "lines", offset: 5 }), /ERANGE: Offset 5 is beyond end of file \(4 lines total\)/);
	assert.equal(accesses.length, 4);
	assert.ok(accesses.every((entry) => entry.allowed));
});

test("empty text, final empty lines, CRLF, and directory misreads have explicit semantics", async () => {
	const { run } = environment([["empty", ""], ["trailing", "a\n"], ["dir/file", "a\r\nb\r\n"]]);
	assert.equal(text(await run("read", { path: "empty" })), "");
	await assert.rejects(run("read", { path: "empty", offset: 2 }), code("ERANGE"));
	assert.equal(text(await run("read", { path: "trailing", offset: 2 })), "");
	assert.equal(text(await run("read", { path: "dir/file", offset: 2, limit: 1 })), "b\r\n\n[Showing lines 2-2 of 3. Use offset=3 to continue.]");
	await assert.rejects(run("read", { path: "." }), code("EISDIR"));
	await assert.rejects(run("read", { path: "dir" }), code("EISDIR"));
	await assert.rejects(run("ls", { path: "empty" }), code("ENOTDIR"));
	await assert.rejects(run("read", { path: "empty/child" }), code("ENOTDIR"));
});

test("offset and read/ls limits reject zero, negatives, fractions, nonnumbers, and unsafe integers", async () => {
	const { run, accesses } = environment([["file", "a"]]);
	for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "2", null]) {
		await assert.rejects(run("read", { path: "file", offset: value }), code("EINVAL"));
		await assert.rejects(run("read", { path: "file", limit: value }), code("EINVAL"));
		await assert.rejects(run("ls", { limit: value }), code("EINVAL"));
	}
	assert.equal(accesses.length, 24);
	assert.ok(accesses.every((entry) => entry.allowed));
});

test("read bounds line output to 2000 and gives an exact continuation offset", async () => {
	const lines = Array.from({ length: DEFAULT_MAX_LINES + 2 }, (_, index) => `line-${index + 1}`);
	const { run } = environment([["long", lines.join("\n")]]);
	const result = await run("read", { path: "long" });
	const details = result.details as { truncation: { content: string; outputLines: number; truncatedBy: string } };
	assert.equal(details.truncation.outputLines, 2000);
	assert.equal(details.truncation.content, lines.slice(0, 2000).join("\n"));
	assert.equal(details.truncation.truncatedBy, "lines");
	assert.match(text(result), /Use offset=2001 to continue/);
	assert.equal(text(await run("read", { path: "long", offset: 2001 })), "line-2001\nline-2002");
	const limited = await run("read", { path: "long", offset: 2, limit: 2001 });
	assert.match(text(limited), /Showing lines 2-2001 of 2002. Use offset=2002/);
});

test("read bounds UTF-8 bytes, preserves complete lines, and never suggests unavailable bash", async () => {
	const line = "中".repeat(200);
	const { run } = environment([["bytes", Array(100).fill(line).join("\n")], ["huge", "🙂".repeat(DEFAULT_MAX_BYTES)]]);
	const result = await run("read", { path: "bytes" });
	const { truncation } = result.details as { truncation: { content: string; outputBytes: number; outputLines: number; truncatedBy: string } };
	assert.equal(truncation.truncatedBy, "bytes");
	assert.ok(truncation.outputBytes <= DEFAULT_MAX_BYTES);
	assert.equal(truncation.outputBytes, Buffer.byteLength(truncation.content));
	assert.equal(truncation.content, Array(truncation.outputLines).fill(line).join("\n"));
	assert.match(text(result), new RegExp(`offset=${truncation.outputLines + 1}`));
	const huge = await run("read", { path: "huge" });
	assert.match(text(huge), /Line 1 exceeds the 50 KiB fixture read limit/);
	assert.doesNotMatch(text(huge), /bash|sed|head -c|�/);
	assert.ok(Buffer.byteLength(text(huge)) < DEFAULT_MAX_BYTES);
	const exact = environment([["exact", "x".repeat(DEFAULT_MAX_BYTES)]]);
	assert.equal(text(await exact.run("read", { path: "exact" })), "x".repeat(DEFAULT_MAX_BYTES));
});

test("ls defaults to root, includes dotfiles, sorts deterministically, and limits entries", async () => {
	const { run, accesses } = environment([["z", ""], ["a", ""], ["A", ""], [".hidden", ""], ["Dir/file", ""], ["b", ""]]);
	assert.equal(text(await run("ls")), ".hidden\nA\na\nb\nDir/\nz");
	assert.equal(text(await run("ls", { path: ".", limit: 2 })), ".hidden\nA\n\n[2 entries limit reached. Use a larger limit for more.]");
	assert.equal(text(await run("ls", { path: "Dir" })), "file");
	assert.deepEqual(accesses[0], { tool: "ls", path: ".", allowed: true, key: "" });
	assert.equal(text(await environment().run("ls")), "(empty directory)");
});

test("ls caps default 500 entries and bytes independently of the requested entry count", async () => {
	const entries: [string, string][] = Array.from({ length: 505 }, (_, i) => [`item-${String(i).padStart(4, "0")}`, ""]);
	const { run } = environment(entries);
	const result = await run("ls");
	assert.equal((result.details as { entryLimitReached: number }).entryLimitReached, 500);
	assert.match(text(result), /item-0499\n\n\[500 entries limit reached/);
	assert.doesNotMatch(text(result), /item-0500/);
	assert.equal(text(await run("ls", { limit: 505 })).split("\n").length, 505);
	const longNames = environment(Array.from({ length: 300 }, (_, i) => [`${String(i).padStart(4, "0")}-${"中".repeat(100)}`, ""]));
	const bytes = await longNames.run("ls", { limit: 1000 });
	const { truncation } = bytes.details as { truncation: { content: string; outputBytes: number } };
	assert.ok(truncation.outputBytes <= DEFAULT_MAX_BYTES);
	assert.ok(Buffer.byteLength(truncation.content) <= DEFAULT_MAX_BYTES);
	assert.match(text(bytes), /50 KiB fixture listing limit reached/);
});

test("legal nonexistent requests are ENOENT, not denied access", async () => {
	const { run, accesses } = environment();
	for (const name of ["read", "ls"] as const) {
		await assert.rejects(run(name, { path: "missing/deep.txt" }), code("ENOENT"));
		await assert.rejects(run(name, { path: "/fixture/missing" }), code("ENOENT"));
	}
	assert.equal(accesses.length, 4);
	assert.ok(accesses.every((entry) => entry.allowed));
});

test("accepts in-root absolute paths on Linux and Windows without trusting ctx.cwd", async () => {
	for (const cwd of ["/fixture", "/fixture/", "D:/fixture", "D:\\fixture\\"]) {
		const { run } = environment([["dir/file", "ok"]], cwd);
		const root = cwd.replace(/[\\/]$/, "");
		assert.equal(text(await run("read", { path: `${root}/dir/file` })), "ok");
		assert.equal(text(await run("ls", { path: root })), "dir/");
		assert.equal(text(await run("read", { path: ".\\dir//./file" })), "ok");
	}
	assert.equal(text(await environment([["file", "ok"]], "D:/fixture").run("read", { path: "d:/FIXTURE/file" })), "ok");
});

test("rejects traversal, external Linux/Windows absolutes, drive-relative and malformed requests once", async () => {
	for (const cwd of ["/fixture", "D:/fixture"]) {
		const { run, accesses } = environment([["file", "ok"]], cwd);
		const paths = ["../secret", "sub/../file", "..\\secret", `${cwd}/../outside`, "/outside/secret", "/fixture-other/file", "C:/secret", "C:\\secret", "D:secret", "\\\\server\\share\\file", "//fixture/file", "file:stream", "~/.ssh/id_rsa", "bad\0name", "", 12, null];
		for (const path of paths) {
			for (const name of ["read", "ls"] as const) {
				const before = accesses.length;
				await assert.rejects(run(name, { path }));
				assert.equal(accesses.length, before + 1);
				assert.deepEqual(accesses.at(-1), { tool: name, path: String(path), allowed: false });
			}
		}
		await assert.rejects(run("read"), code("EINVAL"));
		assert.deepEqual(accesses.at(-1), { tool: "read", path: "undefined", allowed: false });
	}
});

test("pre-aborted executions still emit one boundary audit and do no read", async () => {
	const { run, accesses } = environment([["file", "ok"]]);
	for (const name of ["read", "ls"] as const) {
		await assert.rejects(run(name, { path: "file" }, AbortSignal.abort()), code("ABORT_ERR"));
	}
	assert.deepEqual(accesses, [{ tool: "read", path: "file", allowed: true, key: "file" }, { tool: "ls", path: "file", allowed: true, key: "file" }]);
});

test("construction rejects illegal keys, normalized collisions, and file/directory conflicts", () => {
	const invalid = ["/abs", "C:/abs", "C:relative", "\\\\server\\share", "../escape", "a/../b", "..\\escape", "", ".", "./", "dir/", "dir\\", "nul", "CON.txt", "aux", "COM1.log", "LPT9", "bad:ads", "bad?name", "bad*name", "bad|name", "bad<name", 'bad"name', "trailing.", "trailing ", "bad\0name", "bad\nname", "~/.ssh"];
	for (const path of invalid) assert.throws(() => createReadOnlyTools(CWD, new Map([[path, "x"]])), Error, path);
	for (const entries of [
		[["a", "x"], ["./a", "y"]],
		[["a/b", "x"], ["a\\b", "y"]],
		[["a//b", "x"], ["a/./b", "y"]],
		[["a", "x"], ["a/b", "y"]],
		[["a/b", "x"], ["a", "y"]],
	] as [string, string][][]) assert.throws(() => createReadOnlyTools(CWD, new Map(entries)), /collision|conflict/);
	assert.throws(() => createReadOnlyTools(CWD, new Map([["file", 42]]) as never), code("EINVAL"));
	assert.throws(() => createReadOnlyTools("relative", new Map()), code("EINVAL"));
});

test("fixture tools never touch host fs, including SDK native read path probes", async () => {
	const cwd = fs.mkdtempSync(join(tmpdir(), "pi-fixture-tools-"));
	try {
		fs.writeFileSync(join(cwd, "host-only.txt"), "HOST SECRET");
		fs.writeFileSync(join(cwd, "shadow.txt"), "HOST SHADOW");
		const probes: ReturnType<typeof mock.method>[] = [];
		const blocked = () => { throw new Error("UNEXPECTED HOST FS ACCESS"); };
		try {
			for (const name of ["accessSync", "readFileSync", "statSync", "lstatSync", "readdirSync", "existsSync", "realpathSync", "openSync", "access", "readFile", "stat", "lstat", "readdir", "realpath", "open"] as const) probes.push(mock.method(fs, name, blocked));
			for (const name of ["access", "readFile", "stat", "lstat", "readdir", "realpath", "open"] as const) probes.push(mock.method(fsPromises, name, blocked));
			// Cover SDK named imports from both fs/promises and node:fs/promises too.
			syncBuiltinESMExports();
			const { run, accesses } = environment([["shadow.txt", "MEMORY"], ["dir/file", "nested"]], cwd);
			assert.equal(text(await run("read", { path: "shadow.txt" })), "MEMORY");
			assert.equal(text(await run("read", { path: join(cwd, "shadow.txt") })), "MEMORY");
			await assert.rejects(run("read", { path: "host-only.txt" }), code("ENOENT"));
			assert.equal(text(await run("ls")), "dir/\nshadow.txt");
			assert.equal(text(await run("ls", { path: "dir" })), "file");
			assert.equal(accesses.length, 5);
			for (const probe of probes) assert.equal(probe.mock.callCount(), 0);
		} finally {
			for (const probe of probes.reverse()) probe.mock.restore();
			syncBuiltinESMExports();
		}
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
