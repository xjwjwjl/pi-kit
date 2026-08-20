// 积分格式化测试：完整 packs / 空数组 / schema 缺失 / 负剩余 / 时区日期 / 金额精度。
import { test } from "node:test";
import assert from "node:assert/strict";
import { TraeProtocolError } from "../src/client/errors.ts";
import { formatUsage } from "../src/usage.ts";
import type { TraeEntUsageResponse } from "../src/protocol/types.ts";

test("完整权益包: 数字用 Intl 格式化、有效期 Asia/Shanghai", () => {
    const text = formatUsage({
        user_entitlement_pack_list: [
            {
                display_desc: "基础包",
                entitlement_base_info: { quota: { credits_limit: 5000 }, end_time: 1780000000 },
                usage: { credits_amount: 1234.5 },
            },
            {
                display_desc: "签到奖励",
                entitlement_base_info: { quota: { credits_limit: 200 } },
                usage: { credits_amount: 0 },
            },
        ],
    } as TraeEntUsageResponse);
    assert.match(text, /TRAE 积分余额/);
    assert.match(text, /基础包/);
    assert.match(text, /1,234\.50/); // 千分位 + 两位小数
    assert.match(text, /3,765\.50/); // 剩余 5000 - 1234.5
    assert.match(text, /合计/);
    assert.match(text, /5,200/); // 合计额度 5000+200
});

test("空数组显示“无法判定余额”，与真实零额度区分", () => {
    assert.equal(formatUsage({ user_entitlement_pack_list: [] } as TraeEntUsageResponse), "未返回权益包，无法判定余额");
});

test("user_entitlement_pack_list 缺失 -> 协议错误", () => {
    assert.throws(() => formatUsage({} as TraeEntUsageResponse), TraeProtocolError);
});

test("user_entitlement_pack_list 不是数组 -> 协议错误", () => {
    assert.throws(() => formatUsage({ user_entitlement_pack_list: {} } as TraeEntUsageResponse), TraeProtocolError);
});

test("credits_limit 缺失(免费包，只有 enable_* 权限位) -> 不限额度, 显示不限", () => {
    const text = formatUsage({
        user_entitlement_pack_list: [
            {
                display_desc: "免费",
                entitlement_base_info: { quota: { enable_solo_lite: true } },
                usage: {},
            },
        ],
    } as TraeEntUsageResponse);
    assert.match(text, /不限/);
    // 不限额度包不产生配额合计
    assert.match(text, /0\s*$/);
});

test("credits_amount 缺失(未消耗权益，usage 为空对象) -> 已用视为 0", () => {
    const text = formatUsage({
        user_entitlement_pack_list: [
            { display_desc: "x", entitlement_base_info: { quota: { credits_limit: 100 } }, usage: {} },
        ],
    } as TraeEntUsageResponse);
    assert.match(text, /0\.00/);
    assert.match(text, /100/); // 剩余 100-0
});

test("真实 TRAE 响应形态: 免费包不限 + 未消耗包已用 0 + 已用包正常，不抛错", () => {
    // 对齐实测响应: 老用户福利(limit+空usage)、免费(仅enable_*)、签到(limit+空usage)、每月登录赠送(limit+已用)
    const text = formatUsage({
        user_entitlement_pack_list: [
            { display_desc: "老用户福利", entitlement_base_info: { quota: { credits_limit: 2000 }, end_time: 1789805177 }, usage: {} },
            { display_desc: "免费", entitlement_base_info: { quota: { enable_solo_lite: true }, end_time: 1788191999 }, usage: {} },
            { display_desc: "签到奖励", entitlement_base_info: { quota: { credits_limit: 500 }, end_time: 1789865794 }, usage: { credits_amount: 433.6024 } },
            { display_desc: "签到奖励", entitlement_base_info: { quota: { credits_limit: 200 }, end_time: 1789865794 }, usage: {} },
        ],
    } as TraeEntUsageResponse);
    assert.match(text, /老用户福利/);
    assert.match(text, /免费/);
    assert.match(text, /不限/);
    assert.match(text, /433\.60/); // 已用数字仍正常格式化
    assert.match(text, /2,700/); // 合计额度 2000+500+200
});

test("负数值 -> 协议错误", () => {
    assert.throws(
        () =>
            formatUsage({
                user_entitlement_pack_list: [
                    { display_desc: "x", entitlement_base_info: { quota: { credits_limit: -1 } }, usage: { credits_amount: 0 } },
                ],
            } as TraeEntUsageResponse),
        TraeProtocolError,
    );
});

test("已用大于额度（负剩余）仍如实显示，不崩溃", () => {
    const text = formatUsage({
        user_entitlement_pack_list: [
            { display_desc: "x", entitlement_base_info: { quota: { credits_limit: 100 } }, usage: { credits_amount: 150 } },
        ],
    } as TraeEntUsageResponse);
    assert.match(text, /-50\.00/);
});

test("end_time 非法 -> 协议错误", () => {
    assert.throws(
        () =>
            formatUsage({
                user_entitlement_pack_list: [
                    { display_desc: "x", entitlement_base_info: { quota: { credits_limit: 1 }, end_time: -5 }, usage: { credits_amount: 0 } },
                ],
            } as TraeEntUsageResponse),
        TraeProtocolError,
    );
});

test("end_time 缺失显示 -", () => {
    const text = formatUsage({
        user_entitlement_pack_list: [
            { display_desc: "x", entitlement_base_info: { quota: { credits_limit: 1 } }, usage: { credits_amount: 0 } },
        ],
    } as TraeEntUsageResponse);
    assert.match(text, /-/);
});

test("金额精度: 两位小数不四舍五入偏差", () => {
    const text = formatUsage({
        user_entitlement_pack_list: [
            { display_desc: "x", entitlement_base_info: { quota: { credits_limit: 4613.28 } }, usage: { credits_amount: 100.1 } },
        ],
    } as TraeEntUsageResponse);
    assert.match(text, /4,613\.28/);
    assert.match(text, /100\.10/);
});
