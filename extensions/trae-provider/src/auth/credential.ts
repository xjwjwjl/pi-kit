// TraeCredential：单一 Pi OAuth credential，包含设备身份扩展字段。
// 设备字段（uid/machineId/deviceId）与 token 同存一份，登录/刷新/登出由 Pi CredentialStore 原子管理。
import type { Credential, OAuthCredential } from "@earendil-works/pi-ai";
import { TraeAuthError } from "../client/errors.ts";

export const TRAE_CREDENTIAL_SCHEMA_VERSION = 1 as const;
/** refresh 换发默认有效期 14 天（与 TRAE refreshToken 轮换周期一致） */
export const DEFAULT_TOKEN_DURATION_SECONDS = 1209600;

export interface TraeCredential extends OAuthCredential {
    type: "oauth";
    access: string;
    refresh: string;
    expires: number;
    uid: string;
    machineId: string;
    deviceId: string;
    schemaVersion: 1;
}

/** 完整字段守卫：token + 设备身份 + schemaVersion 全部有效才认为可用。 */
export function isTraeCredential(value: Credential | undefined): value is TraeCredential {
    if (!value || value.type !== "oauth") return false;
    const c = value as Partial<TraeCredential>;
    return (
        typeof c.access === "string" && c.access.length > 0 &&
        typeof c.refresh === "string" && c.refresh.length > 0 &&
        typeof c.uid === "string" && c.uid.length > 0 &&
        typeof c.machineId === "string" && c.machineId.length > 0 &&
        typeof c.deviceId === "string" && c.deviceId.length > 0 &&
        typeof c.expires === "number" && Number.isFinite(c.expires) &&
        c.schemaVersion === TRAE_CREDENTIAL_SCHEMA_VERSION
    );
}

/**
 * 把服务端返回的有效期归一化为 Unix 秒。
 * 只接受明确的秒/毫秒输入：毫秒自动除 1000；缺失或为过去的时刻用 duration fallback。
 */
export function normalizeExpiresSeconds(
    value: number | undefined,
    fallbackDurationSeconds: number | undefined,
    now = Date.now(),
): number {
    const nowSeconds = Math.floor(now / 1000);
    const fallback = fallbackDurationSeconds ?? DEFAULT_TOKEN_DURATION_SECONDS;
    if (value === undefined || !Number.isFinite(value)) return nowSeconds + fallback;
    let seconds = value;
    if (seconds > 1e12) seconds = Math.floor(seconds / 1000); // 毫秒 → 秒
    if (!Number.isFinite(seconds)) return nowSeconds + fallback;
    if (seconds <= nowSeconds) return nowSeconds + fallback; // 过去的时刻 → 用 duration
    return seconds;
}

/** 0.2.0 破坏性迁移提示：旧双文件 credential 不再兼容。 */
export function legacyCredentialError(): TraeAuthError {
    return new TraeAuthError("TRAE Provider 已升级，请使用 /logout 选择 TRAE CN 后重新 /login trae。");
}
