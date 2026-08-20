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
        // 缺失语义（TRAE 服务端实测）：
        //  - quota 无 credits_limit（免费包只有 enable_* 权限位）→ 不限额度
        //  - usage 无 credits_amount / usage 为空对象 {}            → 未消耗，已用 0
        // 仅对上述“缺失”宽容；负数/非 number/非 finite 仍视为脏数据报错。
        const limit = readNonNullOrNegativeNumber(pack.entitlement_base_info?.quota?.credits_limit, "credits_limit");
        const used = readNonNullOrNegativeNumber(pack.usage?.credits_amount, "credits_amount", 0);
        const unlimited = limit === undefined;
        if (typeof limit === "number") totalLimit += limit;
        totalUsed += used;
        rows.push([
            String(pack.display_desc ?? "未知权益包"),
            formatNum(unlimited ? undefined : limit!, integer),
            decimal.format(used),
            formatNum(unlimited ? undefined : limit! - used, decimal),
            formatEndTime(pack.entitlement_base_info?.end_time),
        ]);
    }

    // 固定列宽：权益包(12) 额度(7) 已用(9) 剩余(11) 有效期(右侧, 前导 2 空格)
    const div = "-".repeat(48);
    const header = ["权益包", "额度", "已用", "剩余", "有效期"];
    const lines: string[] = [];
    lines.push("TRAE 积分余额");
    lines.push(div);
    lines.push(rowToString(header));
    lines.push(div);
    for (const r of rows) lines.push(rowToString(r));
    lines.push(div);
    const total = ["合计", integer.format(totalLimit), decimal.format(totalUsed), decimal.format(totalLimit - totalUsed), ""] as const;
    lines.push(rowToString(total));
    return lines.join("\n");
}

/** 按显示宽度填充：中文/全角算 2 格，其余算 1 格。 */
function padVis(s: string, w: number, right = false): string {
    const len = [...s].reduce((n, c) => n + (c.codePointAt(0)! > 0xff ? 2 : 1), 0);
    const pad = Math.max(0, w - len);
    return right ? " ".repeat(pad) + s : s + " ".repeat(pad);
}

/** 权限数值不确定（不限额度）时按“无限/不限”显示。 */
function formatNum(value: number | undefined, fmt: Intl.NumberFormat): string {
    return value === undefined ? "不限" : fmt.format(value);
}

/** 固定列宽拼一行：权益包(12 左对齐) + 额度(7) + 已用(9) + 剩余(11) + 有效期(右侧 2 空格)。 */
function rowToString(row: readonly unknown[]): string {
    const name = String(row[0] ?? "");
    const limit = String(row[1] ?? "");
    const used = String(row[2] ?? "");
    const remain = String(row[3] ?? "");
    const end = String(row[4] ?? "");
    return padVis(name, 12) + "  " + padVis(limit, 5, true) + "  " + padVis(used, 9, true) + "  " + padVis(remain, 11, true) + "  " + end;
}

/**
 * 容错读取权益数字：
 *  - missing 时返回 fallback（credits_amount 缺失=0；credits_limit 缺失=unlimited/undefined 表示不限额度）
 *  - 负数 / 非 number / 非 finite 仍算脏数据，抛协议错误，绝不静默归零。
 * 重载：传了 fallback 即保证返回 number；否则可能为 undefined 表示“不限”。
 */
function readNonNullOrNegativeNumber(value: unknown, field: string, fallback: number, ..._: never[]): number;
function readNonNullOrNegativeNumber(value: unknown, field: string, fallback?: undefined): number | undefined;
function readNonNullOrNegativeNumber(value: unknown, field: string, fallback?: number): number | undefined {
    if (value === undefined || value === null) return fallback;
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
    // 输出 MM-DD（横线分隔），用 Asia/Shanghai 避免 toISOString 的 UTC 日期前移。
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(new Date(ms));
    const get = (type: Intl.DateTimeFormatPartTypes): string =>
        parts.find((p) => p.type === type)?.value ?? "";
    return `${get("month")}-${get("day")}`;
}
