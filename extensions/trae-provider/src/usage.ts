// 积分查询：复用 Pi 已解析、必要时已刷新过的 Provider auth（getProviderAuth("trae")），
// 不再自行取 session 或读磁盘。响应 schema 不符时抛明确错误，绝不显示零余额表。
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import { TraeClient } from "./client/trae-client.ts";
import { TraeProtocolError } from "./client/errors.ts";
import { assertAuthFields, finalRequestHeaders, headerValue } from "./client/headers.ts";
import type { TraeEntUsageResponse } from "./protocol/types.ts";

export const UG_HOST = "https://api.trae.cn";
export const EP_ENT_USAGE = "/trae/api/v2/pay/ide_user_ent_usage";

export interface UsageAuth {
    apiKey: string;
    headers: ProviderHeaders;
    deviceId?: string;
}

export async function getTraeUsageText(client: TraeClient, auth: UsageAuth, signal?: AbortSignal): Promise<string> {
    const headers = finalRequestHeaders("usage", auth.headers);
    assertAuthFields("usage", headers);
    const deviceId = auth.deviceId ?? headerValue(headers, "x-device-id") ?? "";
    const data = await client.requestJson<TraeEntUsageResponse>({
        url: UG_HOST + EP_ENT_USAGE,
        body: {
            require_usage: true,
            // 已验证：req_source 必须为 2，否则权益包缺失（1 会漏签到/老用户福利）
            req_source: 2,
            device_id: deviceId,
        },
        headers,
        signal,
    });
    return formatUsage(data);
}

/** 纯函数格式化；权益包缺失/非数组/字段非法一律抛协议错误。 */
export function formatUsage(data: TraeEntUsageResponse): string {
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
        throw new TraeProtocolError("权益包响应格式不正确");
    }
    const packs = data.user_entitlement_pack_list;
    if (packs === undefined || packs === null) {
        throw new TraeProtocolError("权益包响应缺少 user_entitlement_pack_list");
    }
    if (!Array.isArray(packs)) throw new TraeProtocolError("user_entitlement_pack_list 不是数组");
    if (packs.length === 0) return "未返回权益包，无法判定余额";

    const integer = new Intl.NumberFormat("zh-CN");
    const decimal = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const rows: string[][] = [];
    let totalLimit = 0;
    let totalUsed = 0;
    for (const pack of packs) {
        if (pack === null || typeof pack !== "object" || Array.isArray(pack)) {
            throw new TraeProtocolError("权益包条目格式不正确");
        }
        const limit = readNonNegativeNumber(pack.entitlement_base_info?.quota?.credits_limit, "credits_limit");
        const used = readNonNegativeNumber(pack.usage?.credits_amount, "credits_amount");
        totalLimit += limit;
        totalUsed += used;
        rows.push([
            String(pack.display_desc ?? "未知权益包"),
            integer.format(limit),
            decimal.format(used),
            decimal.format(limit - used),
            formatEndTime(pack.entitlement_base_info?.end_time),
        ]);
    }
    rows.push(["合计", integer.format(totalLimit), decimal.format(totalUsed), decimal.format(totalLimit - totalUsed), ""]);

    const header = ["权益包", "额度", "已用", "剩余", "有效期"];
    const allRows = [header, ...rows];
    const widths = header.map((_, col) => Math.max(...allRows.map((row) => displayLen(row[col] ?? ""))));
    const lines = allRows.map((row) =>
        row.map((cell, col) => (col === 0 ? cell.padEnd(widths[col]) : cell.padStart(widths[col]))).join("  "),
    );
    return ["TRAE 积分余额", ...lines].join("\n");
}

/** 按 Unicode code point 计数做对齐（不做“>0xff 宽度 2”的手工宽度猜测）。 */
function displayLen(text: string): number {
    return Array.from(text).length;
}

function readNonNegativeNumber(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new TraeProtocolError(`权益包字段 ${field} 非法`);
    }
    return value;
}

/** 有效期使用明确时区（TRAE CN 权益为中国区，Asia/Shanghai），避免 toISOString 日期前移。 */
function formatEndTime(value: unknown): string {
    if (value === undefined || value === null) return "-";
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new TraeProtocolError("权益包 end_time 非法");
    }
    const ms = value > 1e12 ? value : value * 1000; // 秒 → 毫秒
    return new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "2-digit",
        day: "2-digit",
    }).format(new Date(ms));
}
