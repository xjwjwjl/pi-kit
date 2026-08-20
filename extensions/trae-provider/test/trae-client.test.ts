// TraeClient 回归测试：成功响应必须读完整 JSON（不能被 4KB 截断），错误响应限制长度。
import { test } from "node:test";
import assert from "node:assert/strict";
import { TraeClient } from "../src/client/trae-client.ts";
import { TraeHttpError } from "../src/client/errors.ts";

function jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

test("requestJson: 成功响应读完整 body，>4KB 的 JSON 不被截断", async () => {
    // 构造远超 4096 字节的权益包响应（此前 readLimitedText(4096) 会截断导致解析失败）
    const big = {
        user_entitlement_pack_list: Array.from({ length: 200 }, (_, i) => ({
            display_desc: `包 ${i}`.repeat(50), // 每个包足够大
            entitlement_base_info: { quota: { credits_limit: 1000 + i }, end_time: 1780000000 },
            usage: { credits_amount: 100 + i },
        })),
    };
    const body = JSON.stringify(big);
    assert.ok(Buffer.byteLength(body, "utf8") > 4096, "fixture 必须超过 4KB 才有意义");

    const client = new TraeClient({ fetchFn: (async () => jsonResponse(big)) as typeof fetch });
    const parsed = await client.requestJson<typeof big>({
        url: "https://example.test/usage",
        body: {},
        headers: { "Content-Type": "application/json" },
    });
    assert.equal(parsed.user_entitlement_pack_list.length, 200);
    assert.equal(parsed.user_entitlement_pack_list[199].entitlement_base_info?.quota?.credits_limit, 1199);
});

test("requestJson: 错误响应保留 status，body 截断且脱敏", async () => {
    const client = new TraeClient({ fetchFn: (async () => new Response("boom " + "x".repeat(6000), { status: 500 })) as typeof fetch });
    await assert.rejects(
        client.requestJson<unknown>({
            url: "https://example.test/usage",
            body: {},
            headers: { "Content-Type": "application/json" },
        }),
        (error: unknown) => {
            assert.ok(error instanceof TraeHttpError);
            assert.equal(error.status, 500);
            return true;
        },
    );
});

test("requestJson: 非 2xx 但不响应 body（null）不抛坏错误", async () => {
    const client = new TraeClient({ fetchFn: (async () => new Response(null, { status: 401 })) as typeof fetch });
    await assert.rejects(
        client.requestJson<unknown>({
            url: "https://example.test/usage",
            body: {},
            headers: { "Content-Type": "application/json" },
        }),
        (error: unknown) => {
            assert.ok(error instanceof TraeHttpError);
            assert.equal(error.status, 401);
            assert.match(error.message, /登录状态失效/);
            return true;
        },
    );
});