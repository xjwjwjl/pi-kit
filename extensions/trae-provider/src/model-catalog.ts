// TRAE 模型目录。thinking 控制字段与 max output 控制未经验证：
// 不声明 thinkingLevelMap，请求体不发送任何 thinking / max_tokens 字段（见 refactor plan §8.3）。
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
        // 已验证：output 事件持续回传 reasoning_content（模型自动思考），
        // 因此声明 reasoning: true 用于展示 thinking 块；但请求级思考控制字段未验证，
        // 故不提供 thinkingLevelMap。
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000000,
        // 仅元数据上限；请求级 max_tokens 控制未验证，不发送
        maxTokens: 384000,
    },
];
