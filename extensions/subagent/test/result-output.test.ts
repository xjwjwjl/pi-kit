import assert from "node:assert/strict";
import fs from "node:fs";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { test, type TestContext } from "node:test";
import { INLINE_RESULT_LIMIT, prepareResultOutput } from "../src/result-output.ts";
import type { RunOutcome } from "../src/outcome.ts";

const finished = (responseText = "hello"): RunOutcome => ({
	status: "finished", responseText, usage: { tokens: 1, cost: 0 }, toolUses: 0,
});

async function temporaryOptions(t: TestContext): Promise<{ agentDir: string; cwd: string }> {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-result-output-"));
	t.after(() => rm(agentDir, { recursive: true, force: true }));
	// Deliberately does not exist: rendering must not create a project directory.
	return { agentDir, cwd: join(agentDir, "untouched-project") };
}

async function assertFullFile(output: Awaited<ReturnType<typeof prepareResultOutput>>, expected: string): Promise<void> {
	assert.equal(output.truncated, true);
	assert.equal(output.total, expected.length);
	assert.ok(output.fullOutputPath);
	assert.ok(isAbsolute(output.fullOutputPath));
	assert.equal(await readFile(output.fullOutputPath, "utf8"), expected);
	assert.ok(output.text.includes(output.fullOutputPath));
	assert.match(output.text, /truncated/i);
	assert.match(output.text, /\bread\b/);
}

test("short results retain original whitespace without creating artifacts", async (t) => {
	const options = await temporaryOptions(t);
	const response = "  answer\n\nline two\n\t";
	assert.deepEqual(await prepareResultOutput(finished(response), options), {
		text: response, total: response.length, truncated: false,
	});
	assert.deepEqual(await readdir(options.agentDir), []);
	await assert.rejects(access(options.cwd));
});

test("empty and whitespace-only completed results display (no output)", async (t) => {
	const options = await temporaryOptions(t);
	for (const response of ["", " \n\t\r\n"]) {
		assert.deepEqual(await prepareResultOutput(finished(response), options), {
			text: "(no output)", total: 11, truncated: false,
		});
	}
});

test("failures include an explicit error and verbatim nonempty partial response", async (t) => {
	const options = await temporaryOptions(t);
	const partial = "  intermediate answer\n\nlast line\n";
	const output = await prepareResultOutput({ ...finished(partial), status: "failed", error: "provider unavailable" }, options);
	assert.equal(output.text, `Error: provider unavailable\n\n${partial}`);
	assert.equal(output.total, output.text.length);
	assert.equal(output.truncated, false);
	for (const error of ["", "  "]) {
		const emptyFailure = await prepareResultOutput({ ...finished(""), status: "failed", error }, options);
		assert.match(emptyFailure.text, /^Error: .*failed/);
	}
});

test("all cancellation reasons are explicit and retain partial text", async (t) => {
	const options = await temporaryOptions(t);
	for (const reason of ["cancelled", "turn_limit", "sdk_abort"] as const) {
		const partial = "  partial\n\nanswer\n";
		const output = await prepareResultOutput({ ...finished(partial), status: "aborted", reason }, options);
		assert.ok(output.text.includes(reason));
		assert.ok(output.text.endsWith(partial));
		assert.match(output.text, /^Aborted:/);
		assert.equal(output.truncated, false);
	}
});

test("cleanup warnings remain visible for every status", async (t) => {
	const options = await temporaryOptions(t);
	const warning = "an in-process tool may still be unwinding";
	const outcomes: RunOutcome[] = [
		finished("answer"),
		{ ...finished("partial"), status: "failed", error: "failure" },
		{ ...finished("partial"), status: "aborted", reason: "cancelled" },
	];
	for (const outcome of outcomes) {
		const output = await prepareResultOutput({ ...outcome, cleanupWarning: warning }, options);
		assert.ok(output.text.includes(`Cleanup warning: ${warning}`));
		assert.ok(output.text.endsWith(outcome.responseText));
	}
	const emptyWarning = await prepareResultOutput({ ...finished(""), cleanupWarning: "" }, options);
	assert.match(emptyWarning.text, /Cleanup warning:/);
	assert.match(emptyWarning.text, /\(no output\)/);
});

test("default limit includes exactly 12000 characters and spills the next character", async (t) => {
	const options = await temporaryOptions(t);
	assert.equal(INLINE_RESULT_LIMIT, 12_000);
	const exact = "a".repeat(INLINE_RESULT_LIMIT);
	assert.deepEqual(await prepareResultOutput(finished(exact), options), { text: exact, total: exact.length, truncated: false });
	assert.deepEqual(await readdir(options.agentDir), []);
	const output = await prepareResultOutput(finished(exact + "b"), options);
	await assertFullFile(output, exact + "b");
	assert.equal(output.text.length, INLINE_RESULT_LIMIT);
	assert.ok(output.text.startsWith("aaa"));
	assert.equal(relative(options.agentDir, output.fullOutputPath!).split(/[\\/]/)[0], "subagent-results");
	assert.match(output.fullOutputPath!, /\.txt$/);
	await assert.rejects(access(options.cwd));
});

test("truncated full text includes errors, partial response, and cleanup warning", async (t) => {
	const options = await temporaryOptions(t);
	const outcome: RunOutcome = {
		...finished("partial\n\n".repeat(2_000)), status: "failed", error: "network stopped",
		cleanupWarning: "cleanup timed out",
	};
	const complete = await prepareResultOutput(outcome, { ...options, limit: 1_000_000 });
	const output = await prepareResultOutput(outcome, { ...options, limit: 1_024 });
	await assertFullFile(output, complete.text);
	assert.equal(output.text.length, 1_024);
	assert.match(output.text, /Error: network stopped/);
	assert.match(output.text, /Cleanup warning: cleanup timed out/);
});

test("minimum viable limit retains a prefix and pointer; lower limits reject before writing", async (t) => {
	const options = await temporaryOptions(t);
	const outcome = finished("x".repeat(4_000));
	const probe = await prepareResultOutput(outcome, { ...options, limit: 1_024 });
	const suffixLength = probe.text.slice(probe.text.indexOf("\n\n[Output truncated.")).length;
	const minimum = suffixLength + 1;
	const output = await prepareResultOutput(outcome, { ...options, limit: minimum });
	assert.equal(output.text.length, minimum);
	assert.ok(output.text.startsWith("x\n\n[Output truncated."));
	await assertFullFile(output, outcome.responseText);
	const existing = await readdir(dirname(output.fullOutputPath!));
	await assert.rejects(prepareResultOutput(outcome, { ...options, limit: minimum - 1 }), /too small.*path.*read hint/);
	assert.deepEqual(await readdir(dirname(output.fullOutputPath!)), existing);
});

test("tiny prefixes still disclose failure, cancellation reason, and cleanup warnings", async (t) => {
	const options = await temporaryOptions(t);
	const outcomes: RunOutcome[] = [
		{ ...finished("partial".repeat(1_000)), status: "failed", error: "error detail ".repeat(100), cleanupWarning: "still unwinding" },
		{ ...finished("partial".repeat(1_000)), status: "aborted", reason: "cancelled", cleanupWarning: "still unwinding" },
		{ ...finished("partial".repeat(1_000)), status: "aborted", reason: "turn_limit", limit: 12, cleanupWarning: "still unwinding" },
	];
	for (const outcome of outcomes) {
		const complete = await prepareResultOutput(outcome, { ...options, limit: 100_000 });
		const probe = await prepareResultOutput(outcome, { ...options, limit: 1_024 });
		const suffixLength = probe.text.slice(probe.text.indexOf("\n\n[Output truncated.")).length;
		const output = await prepareResultOutput(outcome, { ...options, limit: suffixLength + 1 });
		assert.match(output.text, /Cleanup warning present/);
		assert.ok(output.text.includes(`Status: ${outcome.status}`));
		if (outcome.status === "aborted") {
			assert.ok(output.text.includes(outcome.reason));
			if (outcome.reason === "turn_limit") assert.match(complete.text, /max_turns=12/);
		} else assert.match(output.text, /error details/);
		await assertFullFile(output, complete.text);
	}
});

test("invalid limits reject explicitly even for short results", async (t) => {
	const options = await temporaryOptions(t);
	for (const limit of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
		await assert.rejects(prepareResultOutput(finished(), { ...options, limit }), RangeError);
	}
	assert.deepEqual(await readdir(options.agentDir), []);
});

test("non-ASCII, blank lines, and command-looking data are preserved in the full file", async (t) => {
	const options = await temporaryOptions(t);
	const body = "  中文😀é\n\n\n\t$(touch never-execute)\r\n".repeat(500) + "\n\n";
	const output = await prepareResultOutput(finished(body), { ...options, limit: 1_024 });
	await assertFullFile(output, body);
	assert.equal(output.total, body.length);
	assert.ok(body.startsWith(output.text.slice(0, output.text.indexOf("\n\n[Output truncated."))));
});

test("inline truncation never splits a supplementary Unicode character", async (t) => {
	const options = await temporaryOptions(t);
	const outcome = finished("😀".repeat(2_000));
	const probe = await prepareResultOutput(outcome, { ...options, limit: 1_024 });
	const suffixLength = probe.text.slice(probe.text.indexOf("\n\n[Output truncated.")).length;
	const output = await prepareResultOutput(outcome, { ...options, limit: suffixLength + 3 });
	assert.ok(output.text.startsWith("😀\n\n[Output truncated."));
	assert.equal(output.text.length, suffixLength + 2);
	await assertFullFile(output, outcome.responseText);
	await assert.rejects(prepareResultOutput(outcome, { ...options, limit: suffixLength + 1 }), /too small/);
});

test("concurrent results use unique files and cwd groups without overwriting", async (t) => {
	const options = await temporaryOptions(t);
	const bodies = Array.from({ length: 12 }, (_, i) => `${i}:` + "a".repeat(2_000));
	const outputs = await Promise.all(bodies.map((body) => prepareResultOutput(finished(body), { ...options, limit: 1_024 })));
	assert.equal(new Set(outputs.map((output) => output.fullOutputPath)).size, bodies.length);
	assert.equal(new Set(outputs.map((output) => dirname(output.fullOutputPath!))).size, 1);
	for (const [i, output] of outputs.entries()) await assertFullFile(output, bodies[i]);
	const other = await prepareResultOutput(finished(bodies[0]), { ...options, cwd: options.cwd + "-other", limit: 1_024 });
	assert.notEqual(dirname(other.fullOutputPath!), dirname(outputs[0].fullOutputPath!));
	const normalized = await prepareResultOutput(finished(bodies[0]), { ...options, cwd: join(options.cwd, "sub", ".."), limit: 1_024 });
	assert.equal(dirname(normalized.fullOutputPath!), dirname(outputs[0].fullOutputPath!));
});

test("omitted agentDir uses the SDK agent directory, never the project", async (t) => {
	const options = await temporaryOptions(t);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = options.agentDir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	});
	const body = "x".repeat(2_000);
	const output = await prepareResultOutput(finished(body), { cwd: options.cwd, limit: 1_024 });
	await assertFullFile(output, body);
	assert.equal(relative(options.agentDir, output.fullOutputPath!).split(/[\\/]/)[0], "subagent-results");
	await assert.rejects(access(options.cwd));
});

test("artifact directory creation failure rejects without returning a path", async (t) => {
	const options = await temporaryOptions(t);
	await writeFile(join(options.agentDir, "subagent-results"), "existing file");
	await assert.rejects(prepareResultOutput(finished("x".repeat(2_000)), { ...options, limit: 1_024 }));
	assert.equal(await readFile(join(options.agentDir, "subagent-results"), "utf8"), "existing file");
});

test("artifact file write failure rejects and uses exclusive UTF-8 creation", async (t) => {
	const options = await temporaryOptions(t);
	const diskError = Object.assign(new Error("disk full"), { code: "ENOSPC" });
	let attemptedPath = "";
	const mocked = t.mock.method(fs.promises, "writeFile", async (path: unknown, _data: unknown, writeOptions: unknown) => {
		attemptedPath = String(path);
		assert.deepEqual(writeOptions, { encoding: "utf8", flag: "wx", mode: 0o600 });
		throw diskError;
	});
	syncBuiltinESMExports();
	t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
	await assert.rejects(prepareResultOutput(finished("x".repeat(2_000)), { ...options, limit: 1_024 }), (error) => error === diskError);
	assert.ok(isAbsolute(attemptedPath));
	await assert.rejects(access(attemptedPath));
});
