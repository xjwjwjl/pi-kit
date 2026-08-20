// callback server 生命周期测试：ready / 合法回调 / 404 / close 幂等 / 端口冲突 / abort。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { CallbackServer } from "../src/auth/callback-server.ts";

async function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const port = (server.address() as AddressInfo).port;
            server.close(() => resolve(port));
        });
    });
}

function controller(): { signal: AbortSignal; abort: () => void } {
    const c = new AbortController();
    return { signal: c.signal, abort: () => c.abort() };
}

test("waitUntilReady 在 listener 就绪后 resolve；callbackUrl 包含端口与路径", async () => {
    const port = await getFreePort();
    const server = new CallbackServer({ port, path: "/authorize" });
    const { signal } = controller();
    await server.waitUntilReady(signal);
    assert.equal(server.callbackUrl, `http://127.0.0.1:${port}/authorize`);
    await server.close();
});

test("合法回调只 resolve 一次；重复 waitForCallback 都拿到同一 URL", async () => {
    const port = await getFreePort();
    const server = new CallbackServer({ port, path: "/authorize" });
    const { signal } = controller();
    await server.waitUntilReady(signal);
    const p1 = server.waitForCallback(signal);
    const p2 = server.waitForCallback(signal);
    const res = await fetch(`${server.callbackUrl}?refreshToken=abc&login_trace_id=t1`);
    assert.equal(res.status, 200);
    const [u1, u2] = await Promise.all([p1, p2]);
    assert.equal(u1.searchParams.get("refreshToken"), "abc");
    assert.equal(u2.searchParams.get("login_trace_id"), "t1");
    await server.close();
});

test("非预期路径返回 404 且不完成登录", async () => {
    const port = await getFreePort();
    const server = new CallbackServer({ port, path: "/authorize" });
    const { signal, abort } = controller();
    await server.waitUntilReady(signal);
    const pending = server.waitForCallback(signal);
    let settled = false;
    void pending.catch(() => { settled = true; });

    const res = await fetch(`http://127.0.0.1:${port}/other?x=1`);
    assert.equal(res.status, 404);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(settled, false, "非 /authorize 请求不应完成登录");

    abort();
    await assert.rejects(pending);
    await server.close();
});

test("close 幂等，可重复调用", async () => {
    const port = await getFreePort();
    const server = new CallbackServer({ port, path: "/authorize" });
    const { signal } = controller();
    await server.waitUntilReady(signal);
    await server.close();
    await server.close(); // 第二次调用直接返回
    assert.ok(true);
});

test("端口被占时 waitUntilReady reject；close 幂等不抛", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as AddressInfo).port;
    const server = new CallbackServer({ port, path: "/authorize" });
    const { signal } = controller();
    await assert.rejects(server.waitUntilReady(signal));
    await server.close();
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
});

test("waitUntilReady 在 abort 时 reject", async () => {
    const port = await getFreePort();
    const server = new CallbackServer({ port, path: "/authorize" });
    const { signal, abort } = controller();
    const pending = server.waitUntilReady(signal);
    abort();
    await assert.rejects(pending);
    await server.close();
});

test("waitForCallback 在 abort 时 reject", async () => {
    const port = await getFreePort();
    const server = new CallbackServer({ port, path: "/authorize" });
    const { signal } = controller();
    await server.waitUntilReady(signal);
    const { signal: s2, abort: abort2 } = controller();
    const pending = server.waitForCallback(s2);
    abort2();
    await assert.rejects(pending);
    await server.close();
});
