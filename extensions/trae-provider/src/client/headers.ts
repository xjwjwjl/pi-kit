// Header 分层：Pi 已解析 auth headers（身份/JWT）为第 1 层，endpoint profile 为第 2 层，
// 调用方额外 headers 为第 3 层（含 null 删除语义）。合并比较一律忽略大小写。
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import { TraeAuthError } from "./errors.ts";
export const IDE_VERSION = "0.1.43";
export const IDE_VERSION_CODE = "20260716";
export const APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";
export const DEVICE_BRAND = "83DG";
export const OS_VERSION = "Windows 11 Pro";
export const USER_AGENT = `Trae/${IDE_VERSION}`;

export type EndpointProfile = "chat" | "usage" | "oauth";

/** endpoint 固定的协议头（第 2 层）。不包含身份类头，身份由 toAuth / auth.headers 提供。 */
export function profileHeaders(profile: EndpointProfile): Record<string, string> {
    switch (profile) {
        case "chat":
            return {
                "Content-Type": "application/json",
                Accept: "text/event-stream",
                "User-Agent": USER_AGENT,
                "X-App-Id": APP_ID,
                "X-App-Version": "default",
                "X-Ide-Version": IDE_VERSION,
                "X-Ide-Version-Code": IDE_VERSION_CODE,
                "X-App-Version-Code": IDE_VERSION_CODE,
                "X-Ide-Version-Type": "stable",
                "X-Device-Type": "windows",
                "X-OS-Version": OS_VERSION,
                "X-Device-Brand": DEVICE_BRAND,
                "Request-Traffic-Type": "prod",
            };
        case "usage":
            return {
                "Content-Type": "application/json",
                Accept: "application/json",
                "User-Agent": USER_AGENT,
                "X-User-Region": "CN",
            };
        case "oauth":
            return {
                "Content-Type": "application/json",
                "User-Agent": USER_AGENT,
            };
    }
}

/** 大小写无关的多层合并；后层覆盖前层，值为 null 时删除同名 header（Pi 语义）。 */
export function mergeHeaderLayers(sources: (ProviderHeaders | undefined)[]): ProviderHeaders {
    const out: Record<string, string | null> = {};
    for (const source of sources) {
        if (!source) continue;
        for (const [name, value] of Object.entries(source)) {
            const lower = name.toLowerCase();
            for (const existing of Object.keys(out)) {
                if (existing.toLowerCase() === lower) delete out[existing];
            }
            out[name] = value;
        }
    }
    return out;
}

/** 组装最终发送的 headers：profile + 上层，随后丢弃 null。 */
export function finalRequestHeaders(profile: EndpointProfile, upper?: ProviderHeaders): Record<string, string> {
    const layered = mergeHeaderLayers([profileHeaders(profile), upper]);
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(layered)) {
        if (value === null || value === undefined) continue;
        out[name] = value;
    }
    return out;
}

/** 发送前校验认证必需字段存在（不打印其值）。 */
export function assertAuthFields(profile: "chat" | "usage", headers: Record<string, string>): void {
    const lower = new Map<string, string>();
    for (const [name, value] of Object.entries(headers)) lower.set(name.toLowerCase(), value);
    const required = profile === "chat"
        ? ["authorization", "x-uid", "x-device-id", "x-machine-id"]
        : ["authorization", "x-uid", "x-device-id"];
    for (const name of required) {
        const value = lower.get(name);
        if (value === undefined || value.trim() === "") {
            throw new TraeAuthError("TRAE 登录状态不完整，请重新登录（/login trae）");
        }
    }
}

/** 大小写无关地读取某个 header 的值（允许 null 值，供合并中间态使用）。 */
export function headerValue(headers: ProviderHeaders, name: string): string | null | undefined {
    const lower = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === lower) return value;
    }
    return undefined;
}
