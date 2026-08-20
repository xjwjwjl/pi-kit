// TRAE 模型目录。
import type { Model } from "@earendil-works/pi-ai";

/** 自定义 API 标识：llm_utils_chat 明文通道。 */
export type TraeApi = "trae-llm-utils-chat";

export const TRAE_MODELS: readonly Model<TraeApi>[] = [
    {
        id: "DeepSeek-V4-Flash-Official",
        name: "DeepSeek-V4-Flash-Official",
        api: "trae-llm-utils-chat",
        provider: "trae",
        baseUrl: "https://trae-api-cn.mchost.guru",
        // 已验证：output 事件持续回传 reasoning_content（模型自动思考），因此声明 reasoning: true。
        // thinkingLevelMap 对齐用户 deepseek provider 配置：仅 max 受支持（映射到自身），
        // off/minimal/low/medium/high/xhigh 不支持。请求级控制发送 reasoning.effort=max（用户已实测）。
        reasoning: true,
        thinkingLevelMap: {
            off: null,
            minimal: null,
            low: null,
            medium: null,
            high: null,
            xhigh: null,
            max: "max",
        },
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000000,
        // 仅元数据上限；请求级 max_tokens 控制未验证，不发送
        maxTokens: 384000,
    },
];
