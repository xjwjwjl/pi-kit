import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

type RpcLine = {
	type?: string;
	method?: string;
	statusKey?: string;
	statusText?: string;
	event?: string;
	error?: string;
	command?: string;
	success?: boolean;
};

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = path.join(tmpdir(), `sqlkit-pi-load-${Date.now()}`);
const extensionPath = path.join(projectRoot, "index.ts");

function writeJson(filePath: string, value: unknown): void {
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function parseJsonLine(line: string): RpcLine | undefined {
	const text = line.trim().replace(/^\uFEFF/, "");
	if (!text.startsWith("{")) return undefined;
	try {
		return JSON.parse(text) as RpcLine;
	} catch {
		return undefined;
	}
}

function resolvePiCommand(): { command: string; argsPrefix: string[] } {
	if (process.platform !== "win32") return { command: "pi", argsPrefix: [] };

	const whereResult = spawnSync("where.exe", ["pi.cmd"], { encoding: "utf-8" });
	const piCmdPath = whereResult.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean);
	if (!piCmdPath) throw new Error("Unable to locate pi.cmd on PATH.");

	const piBinDir = path.dirname(piCmdPath);
	const nodePath = existsSync(path.join(piBinDir, "node.exe")) ? path.join(piBinDir, "node.exe") : "node";
	const cliCandidates = [
		path.join(piBinDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
		path.join(piBinDir, "node_modules", "@mariozechner", "pi-coding-agent", "dist", "cli.js"),
	];
	const cliPath = cliCandidates.find((candidate) => existsSync(candidate));
	if (!cliPath) {
		throw new Error(`Unable to locate pi CLI entrypoint under ${piBinDir}.`);
	}

	return { command: nodePath, argsPrefix: [cliPath] };
}

mkdirSync(agentDir, { recursive: true });
writeJson(path.join(agentDir, "settings.json"), {
	defaultProvider: "openai",
	defaultModel: "dummy",
});
writeJson(path.join(agentDir, "models.json"), {
	providers: {
		openai: {
			baseUrl: "http://localhost:11434/v1",
			api: "openai-completions",
			apiKey: "DUMMY_KEY_LITERAL",
			models: [{ id: "dummy" }],
		},
	},
});

const piCommand = resolvePiCommand();
const child = spawn(
	piCommand.command,
	[...piCommand.argsPrefix, "--mode", "rpc", "--no-session", "--offline", "-ne", "-e", extensionPath],
	{
		cwd: projectRoot,
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			PI_OFFLINE: "1",
		},
		stdio: ["pipe", "pipe", "pipe"],
	},
);

const stderrLines: string[] = [];
let resolved = false;

function finish(exitCode: number, message: string): void {
	if (resolved) return;
	resolved = true;
	clearTimeout(timeout);
	child.kill();
	rmSync(agentDir, { recursive: true, force: true });
	if (exitCode === 0) {
		console.log(message);
	} else {
		console.error(message);
		if (stderrLines.length > 0) console.error(stderrLines.join("\n"));
	}
	process.exitCode = exitCode;
}

child.once("error", (error) => {
	finish(1, `Failed to start pi CLI: ${error.message}`);
});

child.stderr.setEncoding("utf-8");
child.stderr.on("data", (chunk: string) => {
	stderrLines.push(chunk.trim());
});

const rl = createInterface({ input: child.stdout });
rl.on("line", (line) => {
	const event = parseJsonLine(line);
	if (!event) return;

	if (event.type === "extension_error") {
		finish(1, `pi reported extension_error during ${event.event ?? "unknown event"}: ${event.error ?? "unknown error"}`);
		return;
	}

	if (
		event.type === "extension_ui_request" &&
		event.method === "setStatus" &&
		event.statusKey === "sqlkit" &&
		typeof event.statusText === "string" &&
		(event.statusText === "sqlkit" || event.statusText.startsWith("sqlkit:"))
	) {
		finish(0, `OK pi loaded extension and set status: ${event.statusText}`);
	}
});

child.stdin.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);

const timeout = setTimeout(() => {
	finish(1, "Timed out waiting for pi to load sqlkit extension and emit status.");
}, 8_000);
