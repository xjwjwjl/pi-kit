// OAuth 纯函数测试：登录 URL 构造、回调参数解析（单/双编码）、toAuth、refresh 守卫。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { TraeAuthError } from "../src/client/errors.ts";
import {
    CALLBACK_PORT,
    buildLoginUrl,
    parseCallbackParams,
    refreshTrae,
    toTraeAuth,
    tryParseCallbackUrl,
} from "../src/auth/oauth.ts";
import { TRAE_CREDENTIAL_SCHEMA_VERSION } from "../src/auth/credential.ts";

test("buildLoginUrl 包含机器/设备/登录 trace id 与回调地址", () => {
    const url = buildLoginUrl({ machineId: "m1", deviceId: "d1", loginTraceId: "t1" });
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://www.trae.cn");
    assert.equal(parsed.searchParams.get("machine_id"), "m1");
    assert.equal(parsed.searchParams.get("device_id"), "d1");
    assert.equal(parsed.searchParams.get("login_trace_id"), "t1");
    assert.equal(parsed.searchParams.get("auth_callback_url"), `http://127.0.0.1:${CALLBACK_PORT}/authorize`);
    assert.equal(parsed.searchParams.get("client_id"), "en1oxy7wnw8j9n");
});

test("parseCallbackParams: 单编码 JSON 不做二次解码破坏", () => {
    const url = new URL(
        `http://127.0.0.1:${CALLBACK_PORT}/authorize?refreshToken=rt1&userInfo=${encodeURIComponent('{"UserID":"u9"}')}`,
    );
    const params = parseCallbackParams(url);
    assert.equal(params.refreshToken, "rt1");
    assert.deepEqual(params.userInfo, { UserID: "u9" });
});

test("parseCallbackParams: 遗留双编码输入走受测 fallback", () => {
    const doubleEncoded = encodeURIComponent(encodeURIComponent('{"UserID":"u9"}'));
    const url = new URL(`http://127.0.0.1:${CALLBACK_PORT}/authorize?userInfo=${doubleEncoded}`);
    const params = parseCallbackParams(url);
    assert.deepEqual(params.userInfo, { UserID: "u9" });
});

test("parseCallbackParams: userJwt 提取 Token / RefreshToken / TokenExpireAt", () => {
    const url = new URL(
        `http://127.0.0.1:${CALLBACK_PORT}/authorize?userJwt=${encodeURIComponent('{"Token":"jwt","RefreshToken":"rt2","TokenExpireAt":1800000000}')}`,
    );
    const params = parseCallbackParams(url);
    assert.equal(params.userJwt?.Token, "jwt");
    assert.equal(params.userJwt?.RefreshToken, "rt2");
    assert.equal(params.userJwt?.TokenExpireAt, 1800000000);
});

test("parseCallbackParams: 非法 JSON 忽略对应字段", () => {
    const url = new URL(`http://127.0.0.1:${CALLBACK_PORT}/authorize?userInfo=not-json&refreshToken=rt`);
    const params = parseCallbackParams(url);
    assert.equal(params.refreshToken, "rt");
    assert.equal(params.userInfo, undefined);
});

test("parseCallbackParams: login_trace_id 透传（未回传为 null）", () => {
    const url = new URL(`http://127.0.0.1:${CALLBACK_PORT}/authorize?login_trace_id=trace-1`);
    assert.equal(parseCallbackParams(url).loginTraceId, "trace-1");
    assert.equal(parseCallbackParams(new URL(`http://127.0.0.1:${CALLBACK_PORT}/authorize`)).loginTraceId, null);
});

test("tryParseCallbackUrl: 只接受完整 http(s) URL", () => {
    assert.ok(tryParseCallbackUrl(`http://127.0.0.1:${CALLBACK_PORT}/authorize?x=1`));
    assert.equal(tryParseCallbackUrl("refreshToken=abc"), undefined);
    assert.equal(tryParseCallbackUrl(""), undefined);
    assert.equal(tryParseCallbackUrl("   "), undefined);
});

test("toTraeAuth: 返回 JWT 与身份 headers，不泄露设备字段值到错误", async () => {
    const credential: OAuthCredential = {
        type: "oauth",
        access: "jwt-token",
        refresh: "refresh-token",
        expires: Date.now() + 1_000_000,
        uid: "u1",
        machineId: "m1",
        deviceId: "d1",
        schemaVersion: TRAE_CREDENTIAL_SCHEMA_VERSION,
    } as OAuthCredential;
    const auth = await toTraeAuth(credential);
    assert.equal(auth.apiKey, "jwt-token");
    assert.equal(auth.headers?.Authorization, "Cloud-IDE-JWT jwt-token");
    assert.equal(auth.headers?.["X-Uid"], "u1");
    assert.equal(auth.headers?.["X-Device-Id"], "d1");
    assert.equal(auth.headers?.["X-Machine-Id"], "m1");
});

test("toTraeAuth: 旧格式 credential 抛迁移提示", async () => {
    const old: OAuthCredential = { type: "oauth", access: "jwt", refresh: "rt", expires: Date.now() + 1_000_000 } as OAuthCredential;
    await assert.rejects(toTraeAuth(old), (error: unknown) => {
        assert.ok(error instanceof TraeAuthError);
        assert.match(error.message, /重新 \/login trae/);
        return true;
    });
});

test("refreshTrae: 旧格式 credential 不发起网络请求，直接抛迁移提示", async () => {
    const old: OAuthCredential = { type: "oauth", access: "jwt", refresh: "rt", expires: Date.now() + 1_000_000 } as OAuthCredential;
    await assert.rejects(refreshTrae(old, new AbortController().signal), (error: unknown) => {
        assert.ok(error instanceof TraeAuthError);
        assert.match(error.message, /重新 \/login trae/);
        return true;
    });
});

test("refreshTrae: refresh 为空（不完整凭证）走迁移提示而不是网络", async () => {
    const credential = {
        type: "oauth",
        access: "jwt",
        refresh: "",
        expires: Date.now() + 1_000_000,
        uid: "u1",
        machineId: "m1",
        deviceId: "d1",
        schemaVersion: TRAE_CREDENTIAL_SCHEMA_VERSION,
    } as OAuthCredential;
    await assert.rejects(refreshTrae(credential, new AbortController().signal), /重新 \/login trae/);
});
