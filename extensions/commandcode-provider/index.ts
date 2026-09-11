import { createProvider, type OAuthCredential, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fetchCommandCodeModels } from "./src/api.ts";
import { loginCommandCode } from "./src/auth.ts";
import { COMMAND_CODE_BASE_URL, COMMAND_CODE_PROVIDER_ID, COMMAND_CODE_PROVIDER_NAME } from "./src/constants.ts";
import { fetchCommandCodeModelsForProvider } from "./src/model-catalog.ts";
import { showCommandCodeUsage } from "./src/usage-view.ts";
import { CommandCodeQuotaController } from "./src/quota-controller.ts";

export function createCommandCodeProvider(): Provider<"openai-completions"> {
    return createProvider({
        id: COMMAND_CODE_PROVIDER_ID,
        name: COMMAND_CODE_PROVIDER_NAME,
        baseUrl: COMMAND_CODE_BASE_URL,
        auth: {
            oauth: {
                name: "Command Code account",
                isSubscription: true,
                loginLabel: "Sign in with Command Code",
                login: async (interaction) => {
                    const credential = await loginCommandCode(interaction);
                    const apiKey = credential.key;
                    if (!apiKey) throw new Error("Command Code login did not return an API key.");
                    return {
                        type: "oauth",
                        access: apiKey,
                        // Command Code currently returns a long-lived API key rather than
                        // a refresh token. Keep the same key as refresh material so Pi can
                        // revalidate it if this synthetic credential ever expires.
                        refresh: apiKey,
                        expires: Number.MAX_SAFE_INTEGER,
                    } satisfies OAuthCredential;
                },
                refresh: async (credential, signal) => {
                    await fetchCommandCodeModels(credential.access, signal);
                    return { ...credential, expires: Number.MAX_SAFE_INTEGER };
                },
                toAuth: async (credential) => ({ apiKey: credential.access }),
            },
        },
        models: [],
        fetchModels: fetchCommandCodeModelsForProvider,
        api: openAICompletionsApi(),
    });
}

export default function commandCodeProviderExtension(pi: ExtensionAPI): void {
    const quotaController = new CommandCodeQuotaController();

    pi.on("session_start", (_event, ctx) => {
        quotaController.start(ctx);
    });

    pi.on("session_shutdown", (_event, ctx) => {
        quotaController.stop(ctx);
    });

    pi.on("model_select", (event, ctx) => {
        quotaController.handleModelSelected(ctx, event.model);
    });

    pi.registerProvider(createCommandCodeProvider());
    pi.registerCommand("commandcode-usage", {
        description: "Show Command Code account credits, limits, and usage",
        handler: (_args, ctx) => showCommandCodeUsage(ctx, quotaController),
    });
}
