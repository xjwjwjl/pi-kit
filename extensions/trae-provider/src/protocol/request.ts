// Context -> TRAE llm_utils_chat 请求体。纯函数、无 I/O、无 `as any`。
// 只用角色分支窄化 Pi 消息类型；任何无法表达的 content 都抛明确错误，不静默丢弃。
import type {
    Api,
    AssistantMessage,
    Context,
    Model,
    SimpleStreamOptions,
    ThinkingLevel,
    ToolResultMessage,
    UserMessage,
} from "@earendil-works/pi-ai";
import { TraeProtocolError, TraeUnsupportedInputError } from "../client/errors.ts";
import type { TraeChatMessage, TraeChatRequest, TraeTextBlock, TraeToolCall, TraeToolDefinition } from "./types.ts";

export const TRAE_FUNCTION = "solo_work_lite";

/**
 * 已验证的历史回放策略：上游 assistant 历史只接受文本块，thinking 以 text 回放。
 */
export const THINKING_REPLAY_POLICY = "as-text";

/**
 * 思考控制策略：与用户 deepseek provider 配置（openai-responses）一致，
 * 仅当显式选择受支持的等级（max，见 model-catalog.ts 的 thinkingLevelMap）时
 * 发送 `reasoning: { effort }`；其余等级或不选择时不发送，保持模型自动思考。
 * max 思考经用户实测可用。
 */
export const THINKING_CONTROL_POLICY = "reasoning-effort";

/**
 * 把 Pi 思考等级映射为请求字段值；未受支持（null）或不选择时返回 undefined。
 */
function mapThinkingEffort(model: Model<Api>, level: ThinkingLevel | undefined): string | undefined {
    if (!level) return undefined;
    const mapped = model.thinkingLevelMap?.[level];
    return typeof mapped === "string" && mapped.length > 0 ? mapped : undefined;
}

/**
 * 组装 TRAE 请求体。
 * 思考输出（reasoning_content）已验证可展示；请求级思考控制仅按
 * THINKING_CONTROL_POLICY 映射受支持等级（max）。max_tokens 未实测，不发送。
 */
export function buildTraeChatRequest(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
): TraeChatRequest {
    const messages: TraeChatMessage[] = [];
    if (context.systemPrompt) {
        messages.push({ role: "system", content: [{ type: "text", text: context.systemPrompt }] });
    }
    const pendingToolCallIds = new Set<string>();
    for (const message of context.messages) {
        if (message.role === "user") {
            pushUserMessage(messages, message);
        } else if (message.role === "assistant") {
            pushAssistantMessage(messages, message, pendingToolCallIds);
        } else {
            pushToolResultMessage(messages, message, pendingToolCallIds);
        }
    }
    const request: TraeChatRequest = {
        messages,
        function: TRAE_FUNCTION,
        stream: true,
        config_name: model.id,
        model: model.id,
    };
    const effort = mapThinkingEffort(model, options?.reasoning);
    if (effort) {
        request.reasoning = { effort };
    }
    if (context.tools && context.tools.length > 0) {
        request.tools = context.tools.map(
            (tool): TraeToolDefinition => ({
                type: "function",
                function: {
                    name: tool.name,
                    description: tool.description,
                    // TRAE 上游要求 parameters 序列化为 JSON 字符串
                    parameters: JSON.stringify(tool.parameters),
                },
            }),
        );
    }
    return request;
}

function pushUserMessage(messages: TraeChatMessage[], message: UserMessage): void {
    const content: TraeTextBlock[] = [];
    const blocks =
        typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    for (const block of blocks) {
        if (block.type === "text") {
            content.push({ type: "text", text: block.text });
        } else if (block.type === "image") {
            throw new TraeUnsupportedInputError("当前 TRAE 模型仅支持文本输入，不支持图片");
        }
    }
    messages.push({ role: "user", content });
}

function pushAssistantMessage(
    messages: TraeChatMessage[],
    message: AssistantMessage,
    pendingToolCallIds: Set<string>,
): void {
    const content: TraeTextBlock[] = [];
    const toolCalls: TraeToolCall[] = [];
    for (const block of message.content) {
        if (block.type === "text") {
            content.push({ type: "text", text: block.text });
        } else if (block.type === "thinking") {
            // THINKING_REPLAY_POLICY = as-text（已验证行为）
            content.push({ type: "text", text: block.thinking });
        } else if (block.type === "toolCall") {
            toolCalls.push({
                id: block.id,
                type: "function",
                function_call: { name: block.name, arguments: JSON.stringify(block.arguments) },
            });
            pendingToolCallIds.add(block.id);
        }
    }
    // 空 assistant（无文本无工具调用）上游返回 4001 param invalid，跳过
    if (content.length === 0 && toolCalls.length === 0) return;
    const assistant: TraeChatMessage & { role: "assistant" } = { role: "assistant", content };
    if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
    messages.push(assistant);
}

function pushToolResultMessage(
    messages: TraeChatMessage[],
    message: ToolResultMessage,
    pendingToolCallIds: Set<string>,
): void {
    if (!pendingToolCallIds.has(message.toolCallId)) {
        throw new TraeProtocolError("tool result 与先前 assistant 的工具调用不匹配");
    }
    pendingToolCallIds.delete(message.toolCallId);
    const textParts: string[] = [];
    for (const block of message.content) {
        if (block.type === "text") {
            textParts.push(block.text);
        } else if (block.type === "image") {
            // 当前 text-only 模型：确定性占位说明，不静默丢失图片
            textParts.push("[图片内容：当前 TRAE 模型仅支持文本，工具返回的图片无法读取]");
        }
    }
    let text = textParts.join("");
    if (message.isError) {
        // TRAE 无结构化错误字段（已验证限制）：使用稳定前缀表达错误
        text = text ? `[工具执行错误] ${text}` : "[工具执行错误]";
    }
    messages.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        name: message.toolName,
        content: [{ type: "text", text }],
    });
}
