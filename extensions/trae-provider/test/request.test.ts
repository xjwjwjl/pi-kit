// Context -> TRAE 请求体映射测试（纯函数）。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { TraeProtocolError, TraeUnsupportedInputError } from "../src/client/errors.ts";
import { buildTraeChatRequest, THINKING_REPLAY_POLICY, TRAE_FUNCTION } from "../src/protocol/request.ts";
import type { TraeApi } from "../src/model-catalog.ts";
import { makeModel } from "./helpers.ts";

const model: Model<TraeApi> = makeModel();

function build(
    messages: Context["messages"],
    extras?: Partial<Context> & { tools?: Context["tools"] },
    options?: Parameters<typeof buildTraeChatRequest>[2],
) {
    return buildTraeChatRequest(model, { systemPrompt: extras?.systemPrompt, messages, tools: extras?.tools }, options);
}

test("system + user 文本映射，保留文本顺序", () => {
    const req = build([{ role: "user", content: "你好", timestamp: 1 }], { systemPrompt: "sys" });
    assert.equal(req.function, TRAE_FUNCTION);
    assert.equal(req.stream, true);
    assert.equal(req.config_name, model.id);
    assert.deepEqual(req.messages, [
        { role: "system", content: [{ type: "text", text: "sys" }] },
        { role: "user", content: [{ type: "text", text: "你好" }] },
    ]);
});

test("user content 数组形式（TextContent）", () => {
    const req = build([{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }], timestamp: 1 }]);
    assert.deepEqual(req.messages, [
        { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
    ]);
});

test("user 图片输入被明确拒绝（text-only 模型不伪装支持图片）", () => {
    assert.throws(
        () =>
            build([
                { role: "user", content: [{ type: "image", data: "base64", mimeType: "image/png" }], timestamp: 1 },
            ]),
        TraeUnsupportedInputError,
    );
});

test("assistant: 文本与 thinking（as-text 回放）映射", () => {
    const req = build([
        {
            role: "assistant",
            content: [
                { type: "thinking", thinking: "推理" },
                { type: "text", text: "答案" },
            ],
            api: "trae-llm-utils-chat",
            provider: "trae",
            model: model.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop",
            timestamp: 1,
        },
    ]);
    assert.equal(THINKING_REPLAY_POLICY, "as-text");
    assert.deepEqual(req.messages[0], {
        role: "assistant",
        content: [
            { type: "text", text: "推理" },
            { type: "text", text: "答案" },
        ],
    });
});

test("空 assistant 消息被跳过（TRAE 会 4001）", () => {
    const req = build([
        { role: "user", content: "hi", timestamp: 1 },
        {
            role: "assistant",
            content: [],
            api: "trae-llm-utils-chat",
            provider: "trae",
            model: model.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "pending",
            timestamp: 2,
        },
    ]);
    assert.equal(req.messages.length, 1);
});

test("assistant 工具调用映射到顶层 tool_calls（function_call 格式）", () => {
    const req = build([
        {
            role: "assistant",
            content: [
                {
                    type: "toolCall",
                    id: "call_1",
                    name: "bash",
                    arguments: { command: "ls" },
                },
            ],
            api: "trae-llm-utils-chat",
            provider: "trae",
            model: model.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "toolUse",
            timestamp: 2,
        },
        { role: "user", content: "继续", timestamp: 3 },
    ]);
    const asst = req.messages[0] as { role: "assistant"; tool_calls?: unknown[] };
    assert.ok(Array.isArray(asst.tool_calls));
    assert.deepEqual(asst.tool_calls, [
        { id: "call_1", type: "function", function_call: { name: "bash", arguments: '{"command":"ls"}' } },
    ]);
});

test("tool result: content 必须为数组；isError 加稳定前缀", () => {
    const req = build([
        {
            role: "assistant",
            content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }],
            api: "trae-llm-utils-chat",
            provider: "trae",
            model: model.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "toolUse",
            timestamp: 2,
        },
        {
            role: "toolResult",
            toolCallId: "c1",
            toolName: "bash",
            content: [{ type: "text", text: "file list" }],
            isError: true,
            timestamp: 3,
        },
    ]);
    const tool = req.messages[1] as { role: "tool"; tool_call_id: string; content: unknown[] };
    assert.equal(tool.role, "tool");
    assert.equal(tool.tool_call_id, "c1");
    assert.ok(Array.isArray(tool.content), "content 必须为数组");
    assert.equal((tool.content[0] as { text: string }).text, "[工具执行错误] file list");
});

test("tool result 图片不静默丢失（确定性占位说明）", () => {
    const req = build([
        {
            role: "assistant",
            content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
            api: "trae-llm-utils-chat",
            provider: "trae",
            model: model.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "toolUse",
            timestamp: 2,
        },
        {
            role: "toolResult",
            toolCallId: "c1",
            toolName: "read",
            content: [{ type: "image", data: "base64", mimeType: "image/png" }],
            isError: false,
            timestamp: 3,
        },
    ]);
    const tool = req.messages[1] as { content: { text: string }[] };
    assert.match(tool.content[0].text, /图片内容/);
});

test("未匹配的 tool result 抛协议错误（不发送损坏历史）", () => {
    assert.throws(
        () =>
            build([
                {
                    role: "toolResult",
                    toolCallId: "unknown",
                    toolName: "bash",
                    content: [{ type: "text", text: "x" }],
                    isError: false,
                    timestamp: 1,
                },
            ]),
        TraeProtocolError,
    );
});

test("tools 映射: parameters 为 JSON 字符串", () => {
    const req = build([{ role: "user", content: "hi", timestamp: 1 }], {
        tools: [
            {
                name: "bash",
                description: "运行命令",
                parameters: { type: "object", properties: { command: { type: "string" } } },
            },
        ],
    });
    assert.deepEqual(req.tools, [
        {
            type: "function",
            function: {
                name: "bash",
                description: "运行命令",
                parameters: JSON.stringify({ type: "object", properties: { command: { type: "string" } } }),
            },
        },
    ]);
});

test("无 systemPrompt / 无 tools 时省略对应字段", () => {
    const req = build([{ role: "user", content: "hi", timestamp: 1 }]);
    assert.equal(req.messages[0].role, "user");
    assert.equal(req.tools, undefined);
});

test("thinking map: 选择 max 时发送 reasoning.effort=max（对齐 deepseek provider）", () => {
    const req = build([{ role: "user", content: "hi", timestamp: 1 }], undefined, { reasoning: "max" });
    assert.deepEqual(req.reasoning, { effort: "max" });
});

test("thinking map: xhigh/low/off 均不发送 reasoning 字段（map 中为 null）", () => {
    const xhigh = build([{ role: "user", content: "hi", timestamp: 1 }], undefined, { reasoning: "xhigh" });
    assert.equal(xhigh.reasoning, undefined);
    const low = build([{ role: "user", content: "hi", timestamp: 1 }], undefined, { reasoning: "low" });
    assert.equal(low.reasoning, undefined);
    const off = build([{ role: "user", content: "hi", timestamp: 1 }], undefined, {
        reasoning: "off" as unknown as SimpleStreamOptions["reasoning"],
    });
    assert.equal(off.reasoning, undefined);
});

test("thinking map: 未选择思考等级时不发送 reasoning 字段（默认自动思考）", () => {
    const req = build([{ role: "user", content: "hi", timestamp: 1 }]);
    assert.equal(req.reasoning, undefined);
});
