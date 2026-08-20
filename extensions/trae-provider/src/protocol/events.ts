// SSE frame -> 已验证的 TRAE 领域事件（discriminated union）。
// 不做 "wire JSON 直接 as 事件" 的信任：对象类型、字符串字段、有限非负数、
// 工具调用 index 非负整数都需通过校验。非法 JSON / 非法类型一律 TraeProtocolError。
import { TraeProtocolError } from "../client/errors.ts";
import type { SseFrame } from "./sse.ts";

export interface TraeToolCallDelta {
    index: number;
    id?: string;
    name?: string;
    arguments?: string;
}

export type TraeEvent =
    | { type: "output"; response?: string; reasoningContent?: string; toolCalls?: TraeToolCallDelta[] }
    | {
        type: "usage";
        promptTokens: number;
        completionTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        reasoningTokens?: number;
    }
    | { type: "done"; finishReason: string }
    | { type: "error"; code?: number; message: string }
    | { type: "ignored"; event: string };

export function validateSseEvent(frame: SseFrame): TraeEvent {
    switch (frame.event) {
        case "output":
        case "token_usage":
        case "done":
        case "error":
            return parseKnownEvent(frame.event, frame.data);
        default:
            // 未认识的命名事件忽略（telemetry 前向兼容），策略见测试
            return { type: "ignored", event: frame.event };
    }
}

function parseKnownEvent(name: string, raw: string): TraeEvent {
    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch {
        throw new TraeProtocolError(`SSE ${name} 事件 JSON 非法`);
    }
    switch (name) {
        case "output":
            return parseOutput(json);
        case "token_usage":
            return parseUsage(json);
        case "done":
            return parseDone(json);
        case "error":
            return parseError(json);
        default:
            return { type: "ignored", event: name };
    }
}

function parseOutput(json: unknown): TraeEvent {
    if (!isPlainObject(json)) throw new TraeProtocolError("output 事件不是 JSON 对象");
    const obj = json as Record<string, unknown>;
    const output: Extract<TraeEvent, { type: "output" }> = { type: "output" };
    const response = optionalString(obj.response);
    if (response !== undefined) output.response = response;
    const reasoning = optionalString(obj.reasoning_content);
    if (reasoning !== undefined) output.reasoningContent = reasoning;
    const toolCalls = parseToolCalls(obj.tool_calls);
    if (toolCalls !== undefined) output.toolCalls = toolCalls;
    return output;
}

function parseToolCalls(raw: unknown): TraeToolCallDelta[] | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (!Array.isArray(raw)) throw new TraeProtocolError("tool_calls 不是数组");
    return raw.map((item, i) => {
        if (!isPlainObject(item)) throw new TraeProtocolError(`tool_calls[${i}] 不是对象`);
        const obj = item as Record<string, unknown>;
        const rawIndex = obj.index;
        let index: number;
        if (rawIndex === undefined) {
            index = i;
        } else if (typeof rawIndex === "number" && Number.isInteger(rawIndex) && rawIndex >= 0) {
            index = rawIndex;
        } else {
            throw new TraeProtocolError(`tool_calls[${i}] index 非法`);
        }
        const fn = obj.function_call;
        if (fn !== undefined && fn !== null && !isPlainObject(fn)) {
            throw new TraeProtocolError(`tool_calls[${i}] function_call 不是对象`);
        }
        const fnObj = (fn ?? {}) as Record<string, unknown>;
        const delta: TraeToolCallDelta = { index };
        const id = optionalString(obj.id);
        if (id !== undefined) delta.id = id;
        const name = optionalString(fnObj.name);
        if (name !== undefined) delta.name = name;
        const args = optionalString(fnObj.arguments);
        if (args !== undefined) delta.arguments = args;
        return delta;
    });
}

function parseUsage(json: unknown): TraeEvent {
    if (!isPlainObject(json)) throw new TraeProtocolError("token_usage 事件不是 JSON 对象");
    const obj = json as Record<string, unknown>;
    const usage: Extract<TraeEvent, { type: "usage" }> = {
        type: "usage",
        promptTokens: finiteNonNegative(obj.prompt_tokens, "prompt_tokens"),
        completionTokens: finiteNonNegative(obj.completion_tokens, "completion_tokens"),
        cacheReadTokens: optionalNonNegative(obj.cache_read_input_tokens, "cache_read_input_tokens") ?? 0,
        cacheWriteTokens: optionalNonNegative(obj.cache_write_input_tokens, "cache_write_input_tokens") ?? 0,
    };
    const reasoning = optionalNonNegative(obj.reasoning_tokens, "reasoning_tokens");
    if (reasoning !== undefined) usage.reasoningTokens = reasoning;
    return usage;
}

function parseDone(json: unknown): TraeEvent {
    if (!isPlainObject(json)) throw new TraeProtocolError("done 事件不是 JSON 对象");
    const finishReason = optionalString((json as Record<string, unknown>).finish_reason);
    if (finishReason === undefined) throw new TraeProtocolError("done 事件缺少 finish_reason");
    return { type: "done", finishReason };
}

function parseError(json: unknown): TraeEvent {
    if (!isPlainObject(json)) throw new TraeProtocolError("error 事件不是 JSON 对象");
    const obj = json as Record<string, unknown>;
    const message = optionalString(obj.message);
    if (message === undefined) throw new TraeProtocolError("error 事件缺少 message");
    const parsed: Extract<TraeEvent, { type: "error" }> = { type: "error", message };
    const code = optionalInteger(obj.code);
    if (code !== undefined) parsed.code = code;
    return parsed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") throw new TraeProtocolError("字段类型非法：应为字符串");
    return value;
}

function optionalInteger(value: unknown): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new TraeProtocolError("字段类型非法：应为整数");
    }
    return value;
}

function finiteNonNegative(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new TraeProtocolError(`${field} 非法`);
    }
    return value;
}

function optionalNonNegative(value: unknown, field: string): number | undefined {
    if (value === undefined || value === null) return undefined;
    return finiteNonNegative(value, field);
}
