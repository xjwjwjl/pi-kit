import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { addNativeWebSearchTool, isCodexModel } from "./src/native-search.js";

const AUTO_GUIDANCE =
  "Use Codex's built-in web_search for facts that may have changed, when the user asks to browse or verify information, or when source-backed evidence is needed. If you use web_search, include the most relevant full source URLs in the final answer because the client does not render native search citations.";
const MANUAL_SEARCH_GUIDANCE =
  "Use Codex's built-in web_search for this request before answering. Include the most relevant full source URLs in the final answer because the client does not render native search citations.";

type SearchMode = "auto" | "off";

function modeLabel(mode: SearchMode): string {
  return mode;
}

export default function codexWebSearchExtension(pi: ExtensionAPI): void {
  let enabled = true;
  let manualSearchPending = false;
  let manualSearchInFlight = false;

  const currentMode = (): SearchMode => (enabled ? "auto" : "off");
  const nativeSearchEnabled = () => enabled || manualSearchPending;

  pi.on("session_start", () => {
    enabled = true;
    manualSearchPending = false;
    manualSearchInFlight = false;
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!nativeSearchEnabled() || !isCodexModel(ctx.model)) return;
    const guidance = manualSearchPending ? MANUAL_SEARCH_GUIDANCE : AUTO_GUIDANCE;
    return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!nativeSearchEnabled() || !isCodexModel(ctx.model)) return;

    const required = manualSearchPending;
    const payload = addNativeWebSearchTool(event.payload, { requireSearch: required });
    if (!payload) return;

    if (required) manualSearchInFlight = true;
    return payload;
  });

  pi.on("after_provider_response", (event) => {
    if (!manualSearchInFlight) return;
    manualSearchInFlight = false;
    if (event.status >= 200 && event.status < 500) manualSearchPending = false;
  });

  pi.registerCommand("codex-websearch", {
    description: "Search the web with Codex, or control automatic native search: on, off, or status",
    handler: async (args, ctx) => {
      const input = args.trim();
      const action = input.toLowerCase();

      switch (action) {
        case "":
        case "status":
          ctx.ui.notify(`Codex native web search: ${modeLabel(currentMode())}`, "info");
          return;
        case "on":
          enabled = true;
          ctx.ui.notify("Codex native web search enabled (automatic mode).", "info");
          return;
        case "off":
          enabled = false;
          ctx.ui.notify("Codex native web search disabled for automatic requests. Use /codex-websearch <query> to search manually.", "info");
          return;
      }

      if (!isCodexModel(ctx.model)) {
        ctx.ui.notify("Codex native web search requires an openai-codex Responses model.", "error");
        return;
      }

      manualSearchPending = true;
      pi.sendUserMessage(input);
    },
  });
}
