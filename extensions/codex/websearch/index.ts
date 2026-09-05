import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { addNativeWebSearchTool, isCodexModel } from "./src/native-search.js";

const AUTO_GUIDANCE =
  "Use Codex's built-in web_search for facts that may have changed, when the user asks to browse or verify information, or when source-backed evidence is needed. If you use web_search, include the most relevant full source URLs in the final answer because the client does not render native search citations.";

export default function codexWebSearchExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event, ctx) => {
    if (!isCodexModel(ctx.model)) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${AUTO_GUIDANCE}` };
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!isCodexModel(ctx.model)) return;
    return addNativeWebSearchTool(event.payload);
  });
}
