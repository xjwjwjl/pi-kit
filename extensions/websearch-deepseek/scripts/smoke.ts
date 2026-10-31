import { executeDeepSeekSearch } from "../search.ts";

const query = process.argv.slice(2).join(" ").trim() || "latest DeepSeek API news";

try {
	const result = await executeDeepSeekSearch(query, 5);
	console.log(result.content[0]?.text ?? "");
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
