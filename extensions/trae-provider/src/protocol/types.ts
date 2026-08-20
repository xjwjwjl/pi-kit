// TRAE llm_utils_chat 私有协议的 wire schema 类型（来自逆向抓包 + 社区项目实测）。
// 仅存放 TRAE 线上请求/响应结构，不包含任何运行时逻辑。

// ---------- llm_utils_chat 请求 ----------

export interface TraeChatRequest {
    messages: TraeChatMessage[];
    function: string;
    stream: true;
    config_name: string;
    model: string;
    tools?: TraeToolDefinition[];
    /** 思考控制（对齐用户 deepseek provider 的 openai-responses 格式；max 已实测） */
    reasoning?: { effort: string };
}

export interface TraeTextBlock {
    type: "text";
    text: string;
}

export type TraeChatMessage =
    | { role: "system"; content: TraeTextBlock[] }
    | { role: "user"; content: TraeTextBlock[] }
    | { role: "assistant"; content: TraeTextBlock[]; tool_calls?: TraeToolCall[] }
    | { role: "tool"; tool_call_id: string; name?: string; content: TraeTextBlock[] };

export interface TraeToolDefinition {
    type: "function";
    function: {
        name: string;
        description: string;
        /** TRAE 上游要求 parameters 序列化为 JSON 字符串 */
        parameters: string;
    };
}

/** assistant 顶层 tool_calls，使用已验证的 function_call 格式（不是 content 内嵌） */
export interface TraeToolCall {
    id: string;
    type: "function";
    function_call: {
        name: string;
        arguments: string;
    };
}

// ---------- SSE 事件载荷 ----------

export interface TraeOutputWire {
    response?: string;
    reasoning_content?: string;
    tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function_call?: { name?: string; arguments?: string };
    }>;
}

export interface TraeTokenUsageWire {
    prompt_tokens?: number;
    completion_tokens?: number;
    reasoning_tokens?: number;
    cache_read_input_tokens?: number;
    cache_write_input_tokens?: number;
}

export interface TraeDoneWire {
    finish_reason?: string;
}

export interface TraeErrorWire {
    code?: number;
    message?: string;
}

// ---------- OAuth / 用户信息 ----------

export interface TraeExchangeResult {
    Token?: string;
    RefreshToken?: string;
    TokenExpireAt?: number;
    TokenExpireDuration?: number;
}

export interface TraeGetUserInfoResult {
    UserID?: string;
    ScreenName?: string;
    EnterpriseID?: string;
}

// ---------- 积分查询 ----------

export interface TraeEntitlementPack {
    display_desc?: string;
    entitlement_base_info?: {
        // 有额度包含 credits_limit；免费包只有 enable_* 权限位，无 credits_limit
        quota?: { credits_limit?: number } & Record<string, unknown>;
        end_time?: number;
    };
    usage?: { credits_amount?: number };
}

export interface TraeEntUsageResponse {
    is_credits_billing?: boolean;
    user_entitlement_pack_list?: TraeEntitlementPack[];
}
