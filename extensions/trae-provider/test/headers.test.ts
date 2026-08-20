// header 分层 / 大小写合并 / null 删除 / 认证字段校验测试。
import { test } from "node:test";
import assert from "node:assert/strict";
import { TraeAuthError } from "../src/client/errors.ts";
import {
    assertAuthFields,
    finalRequestHeaders,
    headerValue,
    mergeHeaderLayers,
    profileHeaders,
} from "../src/client/headers.ts";

test("profile: chat 头包含 SSE 与版本头", () => {
    const chat = profileHeaders("chat");
    assert.equal(chat["Content-Type"], "application/json");
    assert.equal(chat.Accept, "text/event-stream");
    assert.equal(chat["X-App-Id"], "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8");
    assert.ok(chat["X-Ide-Version"]);
    assert.equal(chat["Request-Traffic-Type"], "prod");
});

test("profile: usage 头包含 X-User-Region CN；oauth 头最简", () => {
    assert.equal(profileHeaders("usage")["X-User-Region"], "CN");
    assert.equal(profileHeaders("usage").Accept, "application/json");
    const oauth = profileHeaders("oauth");
    assert.equal(oauth.Accept, undefined);
    assert.equal(oauth["Content-Type"], "application/json");
});

test("mergeHeaderLayers: 后层覆盖前层、大小写无关、null 删除", () => {
    const merged = mergeHeaderLayers([
        { "Content-Type": "application/json", "X-Uid": "1", "X-Device-Id": "d" },
        { "content-type": "text/plain", "X-Uid": null },
    ]);
    // 覆盖后保留新 key 的大小写（Pi 语义）；读取必须大小写无关
    assert.equal(headerValue(merged, "content-type"), "text/plain");
    assert.equal(headerValue(merged, "x-uid"), null); // null = 删除标记
    assert.equal(headerValue(merged, "x-device-id"), "d"); // 未覆盖的保留
});

test("finalRequestHeaders: 合并 profile 与上层、丢弃 null", () => {
    const headers = finalRequestHeaders("usage", {
        Authorization: "Cloud-IDE-JWT x",
        "X-Uid": "u1",
        "X-Device-Id": "d1",
        "X-User-Region": null, // 上层 null 删除 profile 的 X-User-Region
    });
    assert.equal(headers["X-Uid"], "u1");
    assert.equal(headers.Authorization, "Cloud-IDE-JWT x");
    assert.equal(headers["X-User-Region"], undefined);
    assert.equal(headers.Accept, "application/json"); // profile 头保留
});

test("assertAuthFields: chat 缺 X-Machine-Id 抛 TraeAuthError", () => {
    assert.throws(
        () => assertAuthFields("chat", { Authorization: "x", "X-Uid": "u", "X-Device-Id": "d" }),
        TraeAuthError,
    );
    assert.doesNotThrow(() =>
        assertAuthFields("chat", { Authorization: "x", "X-Uid": "u", "X-Device-Id": "d", "X-Machine-Id": "m" }),
    );
});

test("assertAuthFields: usage 不需要 X-Machine-Id", () => {
    assert.doesNotThrow(() => assertAuthFields("usage", { Authorization: "x", "X-Uid": "u", "X-Device-Id": "d" }));
    assert.throws(() => assertAuthFields("usage", { Authorization: "x" }), TraeAuthError);
});

test("assertAuthFields: 大小写无关", () => {
    assert.doesNotThrow(() =>
        assertAuthFields("chat", { authorization: "x", "x-uid": "u", "x-device-id": "d", "x-machine-id": "m" }),
    );
});

test("headerValue: 大小写无关读取", () => {
    assert.equal(headerValue({ "X-Device-Id": "abc" }, "x-device-id"), "abc");
    assert.equal(headerValue({ "X-Uid": "u" }, "X-Uid"), "u");
    assert.equal(headerValue({}, "x-uid"), undefined);
});
