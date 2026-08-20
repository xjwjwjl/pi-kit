// stream 状态机测试：文本 / 思考 / 分片工具 / 多工具排序 / 各种失败终态 / abort / usage。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamTrae } from "../src/stream.ts";
import type { TraeApi } from "../src/model-catalog.ts";
import { identityHeaders, makeModel, mockFetch, sseResponse } from "./helpers.ts";

const model: Model<TraeApi> = makeModel();

async function run(options: SimpleStreamOptions, context?: Context): Promise<AssistantMessageEvent[]> {
    const events: AssistantMessageEvent[] = [];
    for await (const event of streamTrae(model, context ?? { messages: [] }, options)) events.push(event);
    return events;
}

function baseOptions(response: Response, extra: Partial<SimpleStreamOptions> = {}): SimpleStreamOptions {
    return { apiKey: "jwt", headers: identityHeaders, fetch: mockFetch(response), ...extra };
}

function doneOf(events: AssistantMessageEvent[]): Extract<AssistantMessageEvent, { type: "done" }> {
    const done = events[events.length - 1];
    assert.equal(done.type, "done");
    return done as Extract<AssistantMessageEvent, { type: "done" }>;
}

test("正常文本: start -> text_start -> delta* -> done(stop)，usage 正确", async () => {
    const events = await run(
        baseOptions(
            sseResponse([
                { event: "output", data: JSON.stringify({ response: "你" }) },
                { event: "output", data: JSON.stringify({ response: "好" }) },
                {
                    event: "token_usage",
                    data: JSON.stringify({
                        prompt_tokens: 10,
                        completion_tokens: 5,
                        cache_read_input_tokens: 3,
                        cache_write_input_tokens: 2,
                        reasoning_tokens: 1,
                    }),
                },
                { event: "done", data: JSON.stringify({ finish_reason: "stop" }) },
            ]),
        ),
    );
    assert.deepEqual(
        events.map((e) => e.type),
        ["start", "text_start", "text_delta", "text_delta", "text_end", "done"],
    );
    const done = doneOf(events);
    assert.equal(done.reason, "stop");
    const text = done.message.content[0];
    assert.equal(text.type, "text");
    if (text.type === "text") assert.equal(text.text, "你好");
    assert.deepEqual(
        {
            input: done.message.usage.input,
            output: done.message.usage.output,
            cacheRead: done.message.usage.cacheRead,
            cacheWrite: done.message.usage.cacheWrite,
            reasoning: done.message.usage.reasoning,
            total: done.message.usage.totalTokens,
        },
        { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, reasoning: 1, total: 20 },
    );
});

test("思考后文本: thinking 与 text block 生命周期完整且顺序正确", async () => {
    const events = await run(
        baseOptions(
            sseResponse([
                { event: "output", data: JSON.stringify({ reasoning_content: "想" }) },
                { event: "output", data: JSON.stringify({ response: "答" }) },
                { event: "done", data: JSON.stringify({ finish_reason: "stop" }) },
            ]),
        ),
    );
    assert.deepEqual(
        events.map((e) => e.type),
        ["start", "thinking_start", "thinking_delta", "text_start", "text_delta", "thinking_end", "text_end", "done"],
    );
    const done = doneOf(events);
    assert.equal(done.message.content[0].type, "thinking");
    assert.equal(done.message.content[1].type, "text");
});

test("分片工具调用: raw JSON 累积后产生正确 ToolCall.arguments", async () => {
    const events = await run(
        baseOptions(
            sseResponse([
                {
                    event: "output",
                    data: JSON.stringify({
                        tool_calls: [{ index: 0, id: "call_1", function_call: { name: "bash", arguments: '{"command":' } }],
                    }),
                },
                {
                    event: "output",
                    data: JSON.stringify({ tool_calls: [{ index: 0, function_call: { arguments: ' "ls"}' } }] }),
                },
                { event: "done", data: JSON.stringify({ finish_reason: "stop" }) },
            ]),
        ),
    );
    const done = doneOf(events);
    assert.equal(done.reason, "toolUse");
    const toolCall = done.message.content.find((b) => b.type === "toolCall");
    assert.ok(toolCall && toolCall.type === "toolCall");
    assert.equal(toolCall.id, "call_1");
    assert.equal(toolCall.name, "bash");
    assert.deepEqual(toolCall.arguments, { command: "ls" });
});

test("多工具调用按 numeric index 稳定排序", async () => {
    const events = await run(
        baseOptions(
            sseResponse([
                {
                    event: "output",
                    data: JSON.stringify({
                        tool_calls: [{ index: 1, id: "c2", function_call: { name: "bash", arguments: '{"a":2}' } }],
                    }),
                },
                {
                    event: "output",
                    data: JSON.stringify({
                        tool_calls: [{ index: 0, id: "c1", function_call: { name: "read", arguments: '{"a":1}' } }],
                    }),
                },
                { event: "done", data: JSON.stringify({ finish_reason: "stop" }) },
            ]),
        ),
    );
    const done = doneOf(events);
    const toolCalls = done.message.content.filter((b) => b.type === "toolCall");
    assert.equal(toolCalls.length, 2);
    assert.equal(toolCalls[0].id, "c1");
    assert.equal(toolCalls[1].id, "c2");
    assert.deepEqual(toolCalls[0].arguments, { a: 1 });
    assert.deepEqual(toolCalls[1].arguments, { a: 2 });
});

test("arguments 先到、id/name 后到也能建块并补发 delta", async () => {
    const events = await run(
        baseOptions(
            sseResponse([
                { event: "output", data: JSON.stringify({ tool_calls: [{ index: 0, function_call: { arguments: '{"x":' } }] }) },
                {
                    event: "output",
                    data: JSON.stringify({
                        tool_calls: [{ index: 0, id: "c1", function_call: { name: "bash", arguments: "1}" } }],
                    }),
                },
                { event: "done", data: JSON.stringify({ finish_reason: "stop" }) },
            ]),
        ),
    );
    assert.deepEqual(
        events.map((e) => e.type),
        ["start", "toolcall_start", "toolcall_delta", "toolcall_end", "done"],
    );
    // 补发的 delta 是完整累积串（两帧拼接后的 {"x":1}），不是分片
    const delta = events.find((e) => e.type === "toolcall_delta");
    assert.equal(delta?.type === "toolcall_delta" ? delta.delta : "", '{"x":1}');
    const done = doneOf(events);
    const toolCall = done.message.content.find((b) => b.type === "toolCall");
    assert.ok(toolCall && toolCall.type === "toolCall");
    assert.deepEqual(toolCall.arguments, { x: 1 });
});

test("工具 arguments 非法 JSON -> 单一 error，不发 done，不产生空对象", async () => {
    const events = await run(
        baseOptions(
            sseResponse([
                {
                    event: "output",
                    data: JSON.stringify({
                        tool_calls: [{ index: 0, id: "c1", function_call: { name: "bash", arguments: "{oops" } }],
                    }),
                },
                { event: "done", data: JSON.stringify({ finish_reason: "stop" }) },
            ]),
        ),
    );
    const last = events[events.length - 1];
    assert.equal(last.type, "error");
    assert.ok(!events.some((e) => e.type === "done"));
    if (last.type === "error") {
        assert.equal(last.reason, "error");
        assert.match(last.error.errorMessage ?? "", /不是合法 JSON/);
    }
});

test("工具调用缺 id -> 协议错误", async () => {
    const events = await run(
        baseOptions(
            sseResponse([
                {
                    event: "output",
                    data: JSON.stringify({ tool_calls: [{ index: 0, function_call: { name: "bash", arguments: "{}" } }] }),
                },
                { event: "done", data: JSON.stringify({ finish_reason: "stop" }) },
            ]),
        ),
    );
    const last = events[events.length - 1];
    assert.equal(last.type, "error");
    if (last.type === "error") assert.match(last.error.errorMessage ?? "", /缺少 id 或 name/);
});

test("服务器 error 事件 -> 单一 error（消息脱敏）", async () => {
    const events = await run(
        baseOptions(
            sseResponse([
                { event: "output", data: JSON.stringify({ response: "partial" }) },
                { event: "error", data: JSON.stringify({ code: 4001, message: "param invalid" }) },
            ]),
        ),
    );
    const last = events[events.length - 1];
    assert.equal(last.type, "error");
    if (last.type === "error") assert.match(last.error.errorMessage ?? "", /param invalid/);
});

test("HTTP 401 -> start 后 error，提示重新登录", async () => {
    const events = await run(baseOptions(new Response("unauthorized", { status: 401 })));
    assert.equal(events[0].type, "start");
    const last = events[events.length - 1];
    assert.equal(last.type, "error");
    if (last.type === "error") {
        assert.equal(last.reason, "error");
        assert.match(last.error.errorMessage ?? "", /登录状态失效/);
    }
});

test("HTTP 500 -> error，保留 status 可诊断", async () => {
    const events = await run(baseOptions(new Response("boom", { status: 500 })));
    const last = events[events.length - 1];
    assert.equal(last.type, "error");
    if (last.type === "error") assert.match(last.error.errorMessage ?? "", /HTTP 500/);
});

test("缺少 response body -> error", async () => {
    const events = await run(baseOptions(new Response(null, { status: 200 })));
    const last = events[events.length - 1];
    assert.equal(last.type, "error");
});

test("EOF 无 done -> TraeStreamIncompleteError（不伪造成功）", async () => {
    const events = await run(
        baseOptions(sseResponse([{ event: "output", data: JSON.stringify({ response: "hi" }) }])),
    );
    const last = events[events.length - 1];
    assert.equal(last.type, "error");
    assert.ok(!events.some((e) => e.type === "done"));
    if (last.type === "error") assert.match(last.error.errorMessage ?? "", /完成事件前中断/);
});

test("未知 finish_reason -> 协议错误", async () => {
    const events = await run(
        baseOptions(sseResponse([{ event: "done", data: JSON.stringify({ finish_reason: "weird_reason" }) }])),
    );
    const last = events[events.length - 1];
    assert.equal(last.type, "error");
    if (last.type === "error") assert.match(last.error.errorMessage ?? "", /未知的 finish_reason/);
});

test("length / max_tokens finish_reason 映射为 length", async () => {
    for (const reason of ["length", "max_tokens"]) {
        const events = await run(baseOptions(sseResponse([{ event: "done", data: JSON.stringify({ finish_reason: reason }) }])));
        const done = doneOf(events);
        assert.equal(done.reason, "length");
    }
});

test("未登录（缺 apiKey）-> start 后 error", async () => {
    const events = await run({ headers: identityHeaders, fetch: mockFetch(sseResponse([])) });
    assert.equal(events[0].type, "start");
    const last = events[events.length - 1];
    assert.equal(last.type, "error");
    if (last.type === "error") assert.match(last.error.errorMessage ?? "", /\/login trae/);
});

test("parent signal abort -> aborted，且 reader/timer 清理（不悬挂）", async () => {
    const controller = new AbortController();
    const events: AssistantMessageEvent[] = [];
    const body = new ReadableStream<Uint8Array>({
        start() {
            // 永不发送数据、永不结束
        },
    });
    const stream = streamTrae(
        model,
        { messages: [] },
        { apiKey: "jwt", headers: identityHeaders, fetch: mockFetch(new Response(body, { status: 200 })), signal: controller.signal },
    );
    const collecting = (async () => {
        for await (const event of stream) events.push(event);
    })();
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await collecting;
    const last = events[events.length - 1];
    assert.equal(last.type, "error");
    if (last.type === "error") {
        assert.equal(last.reason, "aborted");
        assert.equal(last.error.stopReason, "aborted");
    }
});

test("onResponse 在读取 body 前被调用，携带 status 与 headers", async () => {
    let called = false;
    let capturedStatus = 0;
    const events = await run(
        baseOptions(sseResponse([{ event: "done", data: JSON.stringify({ finish_reason: "stop" }) }]), {
            onResponse: (response) => {
                called = true;
                capturedStatus = response.status;
            },
        }),
    );
    assert.equal(called, true);
    assert.equal(capturedStatus, 200);
    assert.equal(doneOf(events).reason, "stop");
});
