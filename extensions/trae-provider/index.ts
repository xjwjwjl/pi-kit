// TRAE provider 扩展入口：仅注册 Provider 与 trae.usage 命令。
// 用法: /login trae 登录后, /model 里选 trae/DeepSeek-V4-Flash-Official
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TraeClient } from "./src/client/trae-client.ts";
import { TraeAuthError } from "./src/client/errors.ts";
import { createTraeProvider } from "./src/provider.ts";
import { getTraeUsageText } from "./src/usage.ts";

export default function (pi: ExtensionAPI) {
    // 原生 Provider：OAuth 生命周期（登录/刷新/登出）由 Pi 管理
    pi.registerProvider(createTraeProvider());

    // 积分统计（通知展示，不进 session 对话）。认证复用 Pi 已解析/已刷新的 Provider auth。
    pi.registerCommand("trae.usage", {
        description: "查看 TRAE 积分统计（额度/已用/剩余）",
        handler: async (_args, ctx) => {
            try {
                const resolved = await ctx.modelRegistry.getProviderAuth("trae");
                if (!resolved?.auth.apiKey) {
                    throw new TraeAuthError("TRAE 未登录，请先运行 /login trae");
                }
                const client = new TraeClient();
                const text = await getTraeUsageText(
                    client,
                    {
                        apiKey: resolved.auth.apiKey,
                        headers: resolved.auth.headers ?? {},
                    },
                    ctx.signal,
                );
                ctx.ui.notify(text, "info");
            } catch (error) {
                ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
            }
        },
    });
}
