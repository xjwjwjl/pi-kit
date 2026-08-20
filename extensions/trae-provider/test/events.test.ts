// wire 事件校验测试：正常 / 非法 JSON / 错误字段类型 / 负 token / 非法 tool index / 未知事件忽略。
import { test } from "node:test";
import assert from "node:assert/strict";
import { TraeProtocolError } from "../src/client/errors.ts";
import { validateSseEvent } from "../src/protocol/events.ts";

test("output: response / reasoning_content / tool_calls 均可选", () => {
    const evt = validateSseEvent({ event: "output", data: '{"response":"hi","reasoning_content":"think"}' });
    assert.deepEqual(evt, { type: "output", response: "hi", reasoningContent: "think" });
    assert.deepEqual(validateSseEvent({ event: "output", data: "{}" }), { type: "output" });
});

test("output: tool_calls 解析为 delta 数组", () => {
    const evt = validateSseEvent({
        event: "output",
        data: '{"tool_calls":[{"index":0,"id":"c1","function_call":{"name":"bash","arguments":"{\\"command\\":"}}]}',
    }) as Extract<ReturnType<typeof validateSseEvent>, { type: "output" }>;
    assert.deepEqual(evt.toolCalls, [{ index: 0, id: "c1", name: "bash", arguments: '{"command":' }]);
});

test("output: 非法 JSON 抛 TraeProtocolError", () => {
    assert.throws(() => validateSseEvent({ event: "output", data: "{bad" }), TraeProtocolError);
});

test("output: tool_calls 不是数组抛错", () => {
    assert.throws(() => validateSseEvent({ event: "output", data: '{"tool_calls":{}}' }), TraeProtocolError);
});

test("output: tool index 非负整数校验（负数/小数抛错）", () => {
    assert.throws(() => validateSseEvent({ event: "output", data: '{"tool_calls":[{"index":-1}]}' }), TraeProtocolError);
    assert.throws(() => validateSseEvent({ event: "output", data: '{"tool_calls":[{"index":1.5}]}' }), TraeProtocolError);
    assert.doesNotThrow(() => validateSseEvent({ event: "output", data: '{"tool_calls":[{"index":0}]}' }));
});

test("usage: 核心字段必填，缓存字段默认 0", () => {
    const evt = validateSseEvent({
        event: "token_usage",
        data: '{"prompt_tokens":10,"completion_tokens":5,"reasoning_tokens":3}',
    });
    assert.deepEqual(evt, {
        type: "usage",
        promptTokens: 10,
        completionTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 3,
    });
});

test("usage: 负 token 抛错", () => {
    assert.throws(
        () => validateSseEvent({ event: "token_usage", data: '{"prompt_tokens":-1,"completion_tokens":2}' }),
        TraeProtocolError,
    );
});

test("usage: 缺核心字段抛错；非数值抛错", () => {
    assert.throws(() => validateSseEvent({ event: "token_usage", data: '{"completion_tokens":2}' }), TraeProtocolError);
    assert.throws(
        () => validateSseEvent({ event: "token_usage", data: '{"prompt_tokens":"10","completion_tokens":2}' }),
        TraeProtocolError,
    );
});

test("done: 需要 finish_reason", () => {
    assert.deepEqual(validateSseEvent({ event: "done", data: '{"finish_reason":"stop"}' }), {
        type: "done",
        finishReason: "stop",
    });
    assert.throws(() => validateSseEvent({ event: "done", data: "{}" }), TraeProtocolError);
});

test("error: message 必填，code 可选", () => {
    assert.deepEqual(validateSseEvent({ event: "error", data: '{"code":4001,"message":"param invalid"}' }), {
        type: "error",
        code: 4001,
        message: "param invalid",
    });
    assert.throws(() => validateSseEvent({ event: "error", data: "{}" }), TraeProtocolError);
});

test("未知命名事件返回 ignored（telemetry 前向兼容）", () => {
    assert.deepEqual(validateSseEvent({ event: "timing_cost", data: "{}" }), {
        type: "ignored",
        event: "timing_cost",
    });
    assert.deepEqual(validateSseEvent({ event: "metadata", data: '{"x":1}' }), {
        type: "ignored",
        event: "metadata",
    });
});
