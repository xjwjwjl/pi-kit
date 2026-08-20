// TRAE OAuth：login / refresh / toAuth。
// login：生成设备身份 -> CallbackServer 就绪后发布 auth URL -> 浏览器回调 / 手动粘贴 / signal 三方竞争
//       -> 解析回调（只解码一次，双编码用受测 fallback）-> ExchangeToken -> GetUserInfo -> 完整 credential。
// refresh：只做 ExchangeToken，完整保留设备身份字段。
// toAuth：从 credential 派生 Pi ModelAuth（JWT + 身份 headers）。
import { randomBytes } from "node:crypto";
import type { ModelAuth, OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { TraeClient } from "../client/trae-client.ts";
import { TraeAuthError, abortError } from "../client/errors.ts";
import { IDE_VERSION, finalRequestHeaders } from "../client/headers.ts";
import { CallbackServer } from "./callback-server.ts";
import {
    TRAE_CREDENTIAL_SCHEMA_VERSION,
    isTraeCredential,
    legacyCredentialError,
    normalizeExpiresSeconds,
} from "./credential.ts";
import type { TraeCredential } from "./credential.ts";
import type { TraeExchangeResult, TraeGetUserInfoResult } from "../protocol/types.ts";

// ---------- 协议常量 ----------

export const OAUTH_HOST = "https://api.trae.com.cn";
export const EP_EXCHANGE = "/cloudide/api/v3/trae/oauth/ExchangeToken";
export const EP_USER_INFO = "/cloudide/api/v3/trae/GetUserInfo";
export const LOGIN_URL_BASE = "https://www.trae.cn/authorization";
export const CALLBACK_PORT = 18080;
export const CALLBACK_PATH = "/authorize";
export const CLIENT_ID = "en1oxy7wnw8j9n"; // SOLO stable
export const PLUGIN_VERSION = "2.3.62834";

const LOGIN_INSTRUCTIONS = "在浏览器完成 TRAE 账号登录，授权后会跳回本地页面（显示『登录成功』），无需复制链接。";
const LOGIN_INSTRUCTIONS_MANUAL =
    "浏览器显示『无法访问此网站』是正常的，说明登录已成功：请复制地址栏完整链接（以 http://127.0.0.1:18080/authorize 开头）粘贴到这里。";

function hex(n: number): string {
    return randomBytes(n).toString("hex");
}

// ---------- 登录 URL ----------

export function buildLoginUrl(input: { machineId: string; deviceId: string; loginTraceId: string }): string {
    const params = new URLSearchParams({
        login_version: "1",
        auth_from: "solo",
        login_channel: "native_ide",
        plugin_version: PLUGIN_VERSION,
        auth_type: "local",
        client_id: CLIENT_ID,
        redirect: "0",
        login_trace_id: input.loginTraceId,
        auth_callback_url: `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`,
        machine_id: input.machineId,
        device_id: input.deviceId,
        x_device_id: input.deviceId,
        x_machine_id: input.machineId,
        x_device_brand: "PC",
        x_device_type: "PC",
        x_os_version: "1.0",
        x_app_version: IDE_VERSION,
        x_app_type: "stable",
    });
    return `${LOGIN_URL_BASE}?${params.toString()}`;
}

// ---------- 回调参数解析 ----------

export interface CallbackParams {
    refreshToken?: string;
    userInfo?: { UserID?: string; [key: string]: unknown };
    userJwt?: { Token?: string; RefreshToken?: string; TokenExpireAt?: number; [key: string]: unknown };
    /** 服务端是否回传 login_trace_id 未确认；回传时必须与本次登录比对。 */
    loginTraceId?: string | null;
}

export function tryParseCallbackUrl(input: string): URL | undefined {
    const trimmed = input.trim();
    if (!/^https?:\/\//i.test(trimmed)) return undefined;
    try {
        return new URL(trimmed);
    } catch {
        return undefined;
    }
}

export function parseCallbackParams(url: URL): CallbackParams {
    const sp = url.searchParams;
    const refreshToken = sp.get("refreshToken") ?? sp.get("refresh_token") ?? undefined;
    const userInfo = parseJsonParam(sp.get("userInfo"));
    const userJwt = parseJsonParam(sp.get("userJwt"));
    return {
        refreshToken,
        userInfo: isPlainObject(userInfo) ? (userInfo as CallbackParams["userInfo"]) : undefined,
        userJwt: isPlainObject(userJwt) ? (userJwt as CallbackParams["userJwt"]) : undefined,
        loginTraceId: sp.get("login_trace_id"),
    };
}

/**
 * URLSearchParams 已完成一次 percent decode；禁止无条件再次 decodeURIComponent。
 * 仅当一次解码后仍不是合法 JSON 时，才尝试二次解码（受测的遗留双编码 fallback）。
 */
function parseJsonParam(raw: string | null): unknown {
    if (!raw) return undefined;
    const direct = tryJsonParse(raw);
    if (direct !== undefined) return direct;
    try {
        return tryJsonParse(decodeURIComponent(raw));
    } catch {
        return undefined;
    }
}

function tryJsonParse(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------- OAuth 网络调用 ----------

async function exchangeToken(client: TraeClient, refreshToken: string, signal?: AbortSignal): Promise<TraeExchangeResult> {
    const data = await client.requestJson<{ Result?: TraeExchangeResult }>({
        url: OAUTH_HOST + EP_EXCHANGE,
        body: { ClientID: CLIENT_ID, RefreshToken: refreshToken, ClientSecret: "-", UserID: "" },
        headers: finalRequestHeaders("oauth"),
        signal,
    });
    return data.Result ?? {};
}

async function getUserInfo(client: TraeClient, access: string, signal?: AbortSignal): Promise<TraeGetUserInfoResult> {
    const data = await client.requestJson<{ Result?: TraeGetUserInfoResult }>({
        url: OAUTH_HOST + EP_USER_INFO,
        body: { ReqSource: "IDE", IDEVersion: IDE_VERSION },
        headers: finalRequestHeaders("oauth", {
            Authorization: `Cloud-IDE-JWT ${access}`,
            "x-cloudide-token": access,
        }),
        signal,
    });
    return data.Result ?? {};
}

// ---------- login ----------

export async function loginTrae(interaction: ProviderAuthInteraction): Promise<TraeCredential> {
    const { signal } = interaction;
    const machineId = hex(16);
    const deviceId = hex(16);
    const loginTraceId = hex(8);
    const loginUrl = buildLoginUrl({ machineId, deviceId, loginTraceId });

    let server: CallbackServer | undefined;
    try {
        server = new CallbackServer({ port: CALLBACK_PORT, path: CALLBACK_PATH });
        let autoCapture = true;
        try {
            await server.waitUntilReady(signal);
            interaction.notify({ type: "auth_url", url: loginUrl, instructions: LOGIN_INSTRUCTIONS });
            interaction.notify({
                type: "progress",
                message: "已启用自动回调捕获：登录完成后浏览器会自动跳回本地页面，无需手动复制链接。",
            });
        } catch (error) {
            if (signal.aborted) throw abortError(signal);
            autoCapture = false;
            interaction.notify({
                type: "progress",
                message: `自动回调捕获不可用（${error instanceof Error ? error.message : String(error)}），请使用手动粘贴方式。`,
            });
            interaction.notify({ type: "auth_url", url: loginUrl, instructions: LOGIN_INSTRUCTIONS_MANUAL });
        }

        const callbackUrl = await waitForCallbackInput({ server, autoCapture, interaction });
        const params = parseCallbackParams(callbackUrl);
        // 若服务端回传 login_trace_id，必须与本次登录一致；不回传是已知协议限制（不做伪造安全保证）
        if (
            params.loginTraceId !== undefined &&
            params.loginTraceId !== null &&
            params.loginTraceId !== loginTraceId
        ) {
            throw new TraeAuthError("登录回调的 login_trace_id 不匹配，登录已取消");
        }
        return await exchangeAndVerify(params, { machineId, deviceId, signal });
    } finally {
        if (server) await server.close();
    }
}

async function waitForCallbackInput(opts: {
    server: CallbackServer;
    autoCapture: boolean;
    interaction: ProviderAuthInteraction;
}): Promise<URL> {
    const { server, autoCapture, interaction } = opts;
    const signal = interaction.signal;
    if (!autoCapture) {
        return promptForCallbackUrl(interaction, signal);
    }
    const manualAbort = new AbortController();
    const onSignalAbort = () => manualAbort.abort();
    signal.addEventListener("abort", onSignalAbort, { once: true });
    if (signal.aborted) manualAbort.abort(); // 已取消时立即生效
    try {
        const callback = server.waitForCallback(manualAbort.signal);
        const manual = promptForCallbackUrl(interaction, manualAbort.signal);
        return await Promise.race([callback, manual]);
    } finally {
        manualAbort.abort();
        signal.removeEventListener("abort", onSignalAbort);
    }
}

async function promptForCallbackUrl(interaction: ProviderAuthInteraction, signal: AbortSignal): Promise<URL> {
    let attempt = 0;
    for (;;) {
        const answer = await interaction.prompt({
            type: "text",
            message:
                attempt === 0
                    ? `浏览器显示『无法访问此网站』是正常的，登录已成功！\n请复制地址栏完整链接（以 http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH} 开头）粘贴到这里：`
                    : `未收到有效链接（第 ${attempt} 次）。请再次复制地址栏完整 URL 粘贴：`,
            signal,
        });
        attempt += 1;
        const url = tryParseCallbackUrl(answer ?? "");
        if (url) return url;
        if (answer && answer.trim()) {
            interaction.notify({
                type: "progress",
                message: `收到内容不是完整链接: "${answer.trim().slice(0, 60)}"。请复制地址栏整行 URL（http:// 开头）`,
            });
        }
    }
}

async function exchangeAndVerify(
    params: CallbackParams,
    ctx: { machineId: string; deviceId: string; signal: AbortSignal },
): Promise<TraeCredential> {
    const { signal } = ctx;
    const client = new TraeClient();
    const refreshToken = params.refreshToken ?? params.userJwt?.RefreshToken;
    let access: string;
    let refresh = "";
    let expiresMs: number;
    if (refreshToken) {
        const result = await exchangeToken(client, refreshToken, signal);
        if (!result.Token) throw new TraeAuthError("ExchangeToken 失败：未返回访问令牌");
        access = result.Token;
        refresh = result.RefreshToken || refreshToken;
        expiresMs = normalizeExpiresSeconds(result.TokenExpireAt, result.TokenExpireDuration) * 1000;
    } else {
        access = typeof params.userJwt?.Token === "string" ? params.userJwt.Token : "";
        const tokenExpireAt =
            typeof params.userJwt?.TokenExpireAt === "number" ? params.userJwt.TokenExpireAt : undefined;
        expiresMs = normalizeExpiresSeconds(tokenExpireAt, undefined) * 1000;
        if (!access) throw new TraeAuthError("回调缺少 refreshToken，且 userJwt 也没有 Token");
    }

    let uid = typeof params.userInfo?.UserID === "string" ? params.userInfo.UserID : "";
    try {
        const info = await getUserInfo(client, access, signal);
        if (info.UserID) uid = String(info.UserID);
    } catch {
        // GetUserInfo 失败时回退回调里的 userInfo；两者都缺则登录失败
    }
    if (!uid) throw new TraeAuthError("无法获取用户 ID，请确认登录成功");

    const credential: TraeCredential = {
        type: "oauth",
        access,
        refresh,
        expires: expiresMs,
        uid,
        machineId: ctx.machineId,
        deviceId: ctx.deviceId,
        schemaVersion: TRAE_CREDENTIAL_SCHEMA_VERSION,
    };
    if (!isTraeCredential(credential)) {
        throw new TraeAuthError("登录结果不完整，请重试");
    }
    return credential;
}

// ---------- refresh / toAuth ----------

export async function refreshTrae(credential: OAuthCredential, signal: AbortSignal): Promise<TraeCredential> {
    if (!isTraeCredential(credential)) throw legacyCredentialError();
    if (!credential.refresh) throw new TraeAuthError("无 refreshToken，请重新登录");
    const client = new TraeClient();
    const result = await exchangeToken(client, credential.refresh, signal);
    if (!result.Token) throw new TraeAuthError("刷新失败，请重新登录");
    const updated: TraeCredential = {
        ...credential,
        access: result.Token,
        refresh: result.RefreshToken || credential.refresh,
        expires: normalizeExpiresSeconds(result.TokenExpireAt, result.TokenExpireDuration) * 1000,
    };
    if (!isTraeCredential(updated)) throw new TraeAuthError("刷新结果不完整，请重新登录");
    return updated;
}

export async function toTraeAuth(credential: OAuthCredential): Promise<ModelAuth> {
    if (!isTraeCredential(credential)) throw legacyCredentialError();
    const access = credential.access;
    return {
        apiKey: access,
        headers: {
            Authorization: `Cloud-IDE-JWT ${access}`,
            "X-Cloudide-Token": access,
            "X-Ide-Token": access,
            "X-Uid": credential.uid,
            "X-Device-Id": credential.deviceId,
            "X-Machine-Id": credential.machineId,
        },
    };
}
