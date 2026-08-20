// credential / expiry 归一化 / 守卫测试。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Credential, OAuthCredential } from "@earendil-works/pi-ai";
import {
    DEFAULT_TOKEN_DURATION_SECONDS,
    TRAE_CREDENTIAL_SCHEMA_VERSION,
    isTraeCredential,
    legacyCredentialError,
    normalizeExpiresSeconds,
} from "../src/auth/credential.ts";
import { TraeAuthError } from "../src/client/errors.ts";

function validCredential(): OAuthCredential {
    return {
        type: "oauth",
        access: "jwt",
        refresh: "rt",
        expires: Date.now() + 600_000,
        uid: "u1",
        machineId: "m1",
        deviceId: "d1",
        schemaVersion: TRAE_CREDENTIAL_SCHEMA_VERSION,
    } as OAuthCredential;
}

test("isTraeCredential: 完整字段为 true", () => {
    assert.equal(isTraeCredential(validCredential()), true);
});

test("isTraeCredential: 缺设备字段为 false（旧格式）", () => {
    const c = validCredential() as Partial<OAuthCredential>;
    delete (c as { uid?: string }).uid;
    assert.equal(isTraeCredential(c as OAuthCredential), false);
});

test("isTraeCredential: schemaVersion 不对为 false", () => {
    const c = validCredential();
    (c as { schemaVersion?: number }).schemaVersion = 2;
    assert.equal(isTraeCredential(c), false);
});

test("isTraeCredential: 非 oauth / undefined 为 false", () => {
    assert.equal(isTraeCredential(undefined), false);
    assert.equal(isTraeCredential({ type: "api_key", key: "x" } as Credential), false);
});

test("normalizeExpiresSeconds: 秒直接通过", () => {
    const now = 1_700_000_000_000;
    assert.equal(normalizeExpiresSeconds(1_800_000_000, undefined, now), 1_800_000_000);
});

test("normalizeExpiresSeconds: 毫秒转为秒", () => {
    const now = 1_700_000_000_000;
    assert.equal(normalizeExpiresSeconds(1_800_000_000_000, undefined, now), 1_800_000_000);
});

test("normalizeExpiresSeconds: 缺失用 duration fallback", () => {
    const now = 1_700_000_000_000;
    assert.equal(normalizeExpiresSeconds(undefined, undefined, now), Math.floor(now / 1000) + DEFAULT_TOKEN_DURATION_SECONDS);
    assert.equal(normalizeExpiresSeconds(undefined, 3600, now), Math.floor(now / 1000) + 3600);
});

test("normalizeExpiresSeconds: 过去的时刻用 duration fallback", () => {
    const now = 1_700_000_000_000;
    const result = normalizeExpiresSeconds(1_500_000_000, undefined, now);
    assert.equal(result, Math.floor(now / 1000) + DEFAULT_TOKEN_DURATION_SECONDS);
});

test("normalizeExpiresSeconds: 非有限值用 duration fallback", () => {
    const now = 1_700_000_000_000;
    assert.equal(normalizeExpiresSeconds(Number.NaN, 7200, now), Math.floor(now / 1000) + 7200);
});

test("refresh 语义: 保留设备字段与 schemaVersion（通过 isTraeCredential 体现）", () => {
    const credential = validCredential();
    const refreshed: OAuthCredential = {
        ...credential,
        access: "new-jwt",
        refresh: "new-rt",
        expires: Date.now() + 1_000_000,
    };
    assert.equal(isTraeCredential(refreshed), true);
    assert.equal((refreshed as { uid?: string }).uid, credential.uid);
    assert.equal((refreshed as { machineId?: string }).machineId, credential.machineId);
    assert.equal((refreshed as { deviceId?: string }).deviceId, credential.deviceId);
    assert.equal((refreshed as { schemaVersion?: number }).schemaVersion, TRAE_CREDENTIAL_SCHEMA_VERSION);
});

test("legacyCredentialError: 迁移提示明确", () => {
    const error = legacyCredentialError();
    assert.ok(error instanceof TraeAuthError);
    assert.match(error.message, /重新 \/login trae/);
});
