import { executeDeepSeekWebSearchQuery, resolveApiKeyInfo } from "../runtime.ts";

function printSection(title: string, body: string) {
	console.log(`\n[${title}]`);
	console.log(body);
}

async function main() {
	const query = process.argv.slice(2).join(" ").trim() || "latest Rust stable release";
	const apiKeyInfo = resolveApiKeyInfo();

	console.log("DeepSeek Web Search smoke test");
	console.log(`Query: ${query}`);
	console.log(`API key source: ${apiKeyInfo.source}`);

	const result = await executeDeepSeekWebSearchQuery(query);
	const outputText = result.content.map((block) => block.text).join("\n\n");

	if (!result.details.ok) {
		printSection("Result", outputText);
		process.exitCode = 1;
		return;
	}

	printSection("Summary", `Path: ${result.details.path}\nModel: ${result.details.model}\nSources: ${result.details.sources.length}`);
	printSection("Answer", result.details.answer || "(empty)");
	printSection("Rendered Output", outputText);
}

await main();
