// SSE parser 测试：分块 / UTF-8 分片 / CRLF / 多 data 行 / 注释 / EOF 冲刷。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSse } from "../src/protocol/sse.ts";

function readerFrom(chunks: (string | Uint8Array)[]): ReadableStreamDefaultReader<Uint8Array> {
    const encoder = new TextEncoder();
    const bytes = chunks.map((c) => (typeof c === "string" ? encoder.encode(c) : c));
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const b of bytes) controller.enqueue(b);
            controller.close();
        },
    });
    return stream.getReader();
}

async function collect(chunks: (string | Uint8Array)[]): Promise<{ event: string; data: string }[]> {
    const frames: { event: string; data: string }[] = [];
    for await (const frame of parseSse(readerFrom(chunks))) frames.push(frame);
    return frames;
}

test("单 chunk 单条 record", async () => {
    const frames = await collect(['event: output\ndata: {"response":"hi"}\n\n']);
    assert.deepEqual(frames, [{ event: "output", data: '{"response":"hi"}' }]);
});

test("多条 data: 行以 \\n 拼接", async () => {
    const frames = await collect(["event: output\ndata: a\ndata: b\n\n"]);
    assert.equal(frames[0].data, "a\nb");
});

test("CRLF 行尾", async () => {
    const frames = await collect(["event: output\r\ndata: x\r\n\r\n"]);
    assert.deepEqual(frames, [{ event: "output", data: "x" }]);
});

test("注释、id、retry 被忽略且不当作 data", async () => {
    const frames = await collect([": keep\nevent: output\nid: 7\nretry: 100\ndata: x\n\n"]);
    assert.deepEqual(frames, [{ event: "output", data: "x" }]);
});

test("UTF-8 跨 chunk 分片不破坏字符", async () => {
    const full = new TextEncoder().encode("event: output\ndata: 你好世界\n\n");
    const mid = Math.floor(full.length / 2);
    const frames = await collect([full.slice(0, mid), full.slice(mid)]);
    assert.equal(frames[0].data, "你好世界");
});

test("任意 chunk 边界（逐字节）", async () => {
    const full = new TextEncoder().encode("event: done\ndata: {\"a\":1}\n\n");
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < full.length; i++) chunks.push(full.subarray(i, i + 1));
    const frames = await collect(chunks);
    assert.deepEqual(frames, [{ event: "done", data: '{"a":1}' }]);
});

test("EOF 未以空行结尾也冲刷最后一条", async () => {
    const frames = await collect(['event: done\ndata: {"finish_reason":"stop"}']);
    assert.deepEqual(frames, [{ event: "done", data: '{"finish_reason":"stop"}' }]);
});

test("event 类型在空行后重置为 message", async () => {
    const frames = await collect(["event: output\ndata: a\n\ndata: b\n\n"]);
    assert.deepEqual(frames, [
        { event: "output", data: "a" },
        { event: "message", data: "b" },
    ]);
});

test("onChunk 每收到一个字节块回调一次", async () => {
    let calls = 0;
    const frames: { event: string; data: string }[] = [];
    for await (const frame of parseSse(readerFrom(["event: a\ndata: 1\n\n"]), () => calls++)) frames.push(frame);
    assert.equal(calls, 1);
    assert.equal(frames.length, 1);
});
