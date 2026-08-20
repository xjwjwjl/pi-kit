# TRAE SOLO CN 逆向工程学习笔记

> 逆向对象：TRAE SOLO CN v0.1.51（Windows，字节跳动 TRAE Work 桌面客户端）
> 学习目标：理解其网络架构、认证体系、LLM 调用协议，并验证"独立复现"可行性
> 方法：静态分析（未打包的 JS 源码 + DLL 字符串）+ 动态抓包（mitmproxy MITM）+ 协议复现实测

---

## 1. 总体结论

- TRAE 是 **Electron(VS Code 派生) + Rust 原生模块** 混合架构，LLM 逻辑在 264MB 的 `ai_agent.dll`。
- 网络层用字节自研 **TTLan/ahanet** 栈（QUIC + HTTPDNS + CDN 分发），但**可降级为 TCP + 系统代理**（改 `server.json` 即可，且证书不 pin，MITM 可行）。
- 存在**双通道**：
  - **WS 信令通道**（`frontier.zijieapi.com/ws/v2`）：明文 protobuf，事件上报 + 任务推送。
  - **HTTP 数据面**（`trae-api-cn.mchost.guru`）：真正的 LLM 请求。
- **关键洞察**：客户端对 `create_agent_task` / `llm_utils_chat` 的 body 做 **x-medusa 加密**，但**服务端兼容明文**——`llm_utils_chat` 用明文 JSON + JWT 头即可直接调用（社区项目 `traework2api` 验证，本人独立实测复现成功）。
- **独立复现完全可行**：只需 JWT（登录态，~14 天有效）+ 明文请求。

---

## 2. 架构总览

```
TRAE SOLO CN.exe (Electron main)
├── resources/app/            # JS 源码（未打包成 asar，直接可读）
│   ├── out/vs/               # VS Code 壳
│   ├── node_modules/@byted-icube/
│   │   ├── ai-modules-chat/  # LLM 聊天逻辑（JS 层）
│   │   ├── solo-lite/        # 业务逻辑（含 frontier adapter）
│   │   ├── desktop-modules/  # 桌面模块
│   │   └── trae-network-client/  # ZeroMQ → Rust 网络服务
│   └── modules/
│       ├── ai-agent/ai_agent.dll  # 264MB Rust 原生模块（LLM 核心）
│       └── ckg/binary/libckg.dll  # 知识库服务
├── AppData/Roaming/TRAE SOLO CN/
│   ├── ahanet/server.json    # TTLan 网络配置（QUIC/HTTPDNS/压缩/分发）
│   ├── logs/                 # main.log 记录所有 JS 层请求 URL
│   └── ModularData/ai-agent/database.db  # 加密 SQLite（凭证持久化）
```

关键进程：TRAE 主进程监听 `127.0.0.1:17788`（IPC，需 `x-jwt-token`），CKG 服务监听 `127.0.0.1:51000`。

---

## 3. 网络层：TTLan/ahanet 自研栈

`ahanet/server.json` 暴露了完整网络配置（本文所有关键字段）：

| 配置 | 值 | 含义 |
|---|---|---|
| `ttnet_quic_enabled` | 1 | 启用 QUIC(HTTP/3) |
| `ttnet_http_dns_enabled` | 1 | 启用 HTTPDNS（绕过系统 DNS） |
| `ttnet_enable_br` | 1 | Brotli 压缩 |
| `tt_compress.enabled` | 1 | 对指定路径做压缩封装（`equal_path` 列出 llm_raw_chat 等） |
| `ttnet_dispatch_actions` | CDN 调度 | `trae-api-cn.mchost.guru → api5-normal.mchost.guru` |
| `chromium_open` | 1 | 部分流量走 Chromium 栈 |

**对抓包的意义**：
- QUIC 是 UDP，不经 HTTP 代理；HTTPDNS 绕过系统 DNS。默认状态下标准 MITM 抓不到 LLM 明文。
- **但**：改 `server.json` 禁用 QUIC/HTTPDNS 后，TTLan 降级走 TCP + 系统代理，且**不校验证书 pin**——mitmproxy 加系统根证书后即可完整 MITM。
- 该配置由服务端动态下发生成，重启客户端可能被覆盖（实测重启后仍生效）。

---

## 4. 凭证体系（四层）

| 凭证 | 有效期 | 位置 | 用途 |
|---|---|---|---|
| `refreshToken` | 长期 | 客户端登录后本地 | 换发 accessToken |
| `accessToken`（JWT, RS256） | **~14 天** | `x-ide-token` / `Authorization: Cloud-IDE-JWT` | 所有 API 认证 |
| `access_key` | 设备级（长） | WS URL 参数 | frontier WS 连接鉴权 |
| `X-Cylons` token | 消息级 | WS protobuf F5 | WS 消息签名 |

- JWT payload 示例（脱敏）：`{"data":{"id":"<uid>","source":"refresh_token","source_id":"<密文>","tenant_id":"<tid>","type":"user"},"exp":<ts>,"iat":<ts>}`
- 设备绑定：`machine_id`（机器指纹）、`device_id`、`device_model` 一起参与认证。
- **JWT 可直接用于明文 llm_utils_chat 调用**（实测成功），无需 WS 凭证。

---

## 5. 双通道架构

```
用户发消息
  ├─→ WS (frontier.zijieapi.com/ws/v2)  信令/上报：metadata(含query)、plan_item、token_usage、done
  └─→ HTTP (trae-api-cn.mchost.guru)    数据面：create_agent_task / llm_utils_chat（SSE 流式）
```

- `main.log` 只记录 JS 层（undici fetch）请求；`create_agent_task` 由原生层直接发出，不经过 JS、不记日志。
- `llm_utils_chat` 走 JS 层（可被 mitmproxy 抓到），社区项目据此实现。

---

## 6. WS 信令协议（protobuf 全解）

连接：`GET /ws/v2?frontier_id=<id>&device_id=<did>&access_key=<ak>&aid=787976&...` + 34 个 headers（`User-Agent: TraeClient/TTNet`、`x-ide-token`、`smbyttnet:1`、`Sec-WebSocket-Protocol: pbbp2` 等）。

消息封装（protobuf wire format）：

```
F1  [bytes]  = 空(0B)
F2  varint   = 0（客户端事件）或服务端时间戳（ACK 场景）
F3  varint   = 33555672（固定，协议版本/会话标记）
F4  varint   = 1（事件）或 0（ACK）
F5  [bytes]  = 认证头：\n\x08X-Cylons\x12<len><token>
F7  [bytes]  = "application/json"
F8  [bytes]  = 双层 JSON 载荷 {"proto":7,"up_seq_id":N,"data":"<json-string>"}
```

事件类型（F8 内 data 的 events[].type）：

| 事件 | 方向 | 关键字段 |
|---|---|---|
| `metadata` | C2S | message_id, session_id, agent_type=`solo_work_lite`, user_message_context.query（用户消息） |
| `model_config` | C2S | model_name=`DeepSeek-V4-Flash-Official__dev` |
| `plan_item` | C2S | reasoning_content（AI 思考流） |
| `token_usage` | C2S | prompt_tokens / completion_tokens / cache_read_input_tokens |
| `done` | C2S | status, user_message_context.model_info |
| 任务推送 | S2C | `{"proto":1,"path":"/conversations",...}`（服务端让客户端去拉取） |
| ACK | S2C/C2S | `{"proto":8,"seq_num":N}` |

**理解**：WS 上的 C2S 事件是客户端把 LLM 执行结果"上报"给服务端（用于云端记录/多端同步）；真正的 LLM 执行走 HTTP。

---

## 7. HTTP 数据面：llm_utils_chat（明文通道）★核心

端点：`POST https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat`

请求头（关键，其余可省略）：
```
Authorization: Cloud-IDE-JWT <JWT>
X-Ide-Token: <JWT>
X-Cloudide-Token: <JWT>
X-Uid: <uid>
X-Machine-Id: <machine_id>
X-Device-Id: <device_id>
X-App-Id: 6eefa01c-1036-4c7e-9ca5-d891f63bfcd8
Accept: text/event-stream
```

请求体（**明文 JSON，无需加密**）：
```json
{
  "messages": [{"role": "user", "content": [{"type": "text", "text": "你好"}]}],
  "function": "solo_work_lite",
  "stream": true,
  "config_name": "glm-5.2",
  "model": "glm-5.2"
}
```

SSE 响应事件序列：
```
metadata → timing_cost → output×N → extra_info → token_usage → done
```
- `output` 事件：`{"response":"","reasoning_content":"...","tool_calls":null,...}`（AI 增量）
- `token_usage`：`{"prompt_tokens":21,"completion_tokens":159,"total_tokens":180,...}`
- `done`：`{"finish_reason":"stop"}`

其他端点（社区方案验证）：
```
/cloudide/api/v3/trae/oauth/ExchangeToken   # refreshToken 轮换
/trae/api/v2/ug/checkin_credits/status|claim  # 每日签到
/trae/api/v2/pay/ide_user_ent_usage         # 积分查询
```

---

## 8. 加密机制：x-medusa 与"非必须"

客户端对 LLM 请求加这些头 + 加密 body：
```
x-request-pin: <16 hex>        # 疑似 AES 会话 key 提示
x-medusa: <base64>             # 加密元数据（nonce/公钥/参数）
x-helios: <base64>
x-neptune: <id>
x-lgw-req-sdk-type: 3          # LGW(Logic Gateway) SDK 类型
```

- body 经 base64 后是**高熵密文**（brotli/zlib/gzip 均失败）→ 真加密，非压缩。
- **但服务端接受明文**：社区项目 `traework2api` 无任何加密头、纯明文 JSON 即可调用；本人独立实测 HTTP 200 + 完整 SSE 流。
- 结论：medusa 加密是**客户端加固层**（可能是灰度开关 x-lgw-req-sdk-type），**不是服务端强制要求**。这解释了为何纯 Go/纯 Python 能复现。

---

## 9. 社区方案 traework2api 原理（学习参考）

GitHub: `Sliverkiss/traework2api`（Go，零依赖，OpenAI 兼容）

- 通道：`llm_utils_chat` + `function=solo_work_lite`（**非** create_agent_task）
- 认证：明文 `Authorization: Cloud-IDE-JWT <JWT>` + 设备头
- 登录：`login.sh` → 浏览器手机号验证码 → 回调 URL → 解析 refreshToken/userInfo → `ExchangeToken` 换 JWT → 落盘 `auths/trae-{uid}.json`
- Token 维护：过期前 24h 预刷新，refreshToken 轮换原子写回
- 功能：多账号轮转、定时签到（cmd/signin）、积分查询（cmd/credit）
- 模型：默认 `glm-5.2`（实测可用）；客户端自身默认 `DeepSeek-V4-Flash-Official`（`deepseek-v4-flash-0731`，即官方 DeepSeek-V4-Flash）

---

## 10. 独立复现实测

用抓包拿到的 JWT（14 天有效）+ 明文 JSON 调 `llm_utils_chat`：

```python
# 见同目录 trae_proxy.py（完整代理）
url = "https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat"
body = {"messages":[{"role":"user","content":[{"type":"text","text":"1+1=?"}]}],
        "function":"solo_work_lite","stream":True,"config_name":"glm-5.2","model":"glm-5.2"}
# headers 含 Cloud-IDE-JWT 认证 + 设备头
```

**结果**：HTTP 200，SSE 事件 `metadata→timing_cost→output×13→token_usage→done`，回复 `2`，`total_tokens=180`。✅ 完整流程复现成功。

---

## 11. 本地 OpenAI 兼容代理（学习成果应用）

见同目录 `trae_proxy.py`：把 `llm_utils_chat` 封装成 `POST /v1/chat/completions`（OpenAI 格式，SSE 流式），配好 JWT 后即可给 pi 等任意 OpenAI 兼容客户端用：

```json
// ~/.pi/agent/models.json
{
  "providers": {
    "trae": {
      "baseUrl": "http://127.0.0.1:8787/v1",
      "api": "openai-completions",
      "apiKey": "trae-local",
      "models": [
        { "id": "glm-5.2", "name": "TRAE glm-5.2", "contextWindow": 128000 },
        { "id": "deepseek-v4-flash", "name": "TRAE DeepSeek-V4-Flash", "contextWindow": 168000 }
      ]
    }
  }
}
```

---

## 12. 风险与边界（务必知悉）

1. **违反服务条款**：TRAE 积分/模型仅授权官方客户端使用，第三方 API 化属规避计费，违反 ToS。
2. **封号风险**：字节有风控链路（`/trae/api/v3/trae/risk_control`）；异常调用模式（频率、来源）可能触发，账号有封禁风险。
3. **稳定性**：接口无文档、随时可变；`llm_utils_chat` 当前可用不保证未来不变。
4. **JWT 时效**：14 天需刷新（refreshToken → ExchangeToken），refreshToken 长期有效但每次轮换。
5. **积分计费**：llm_utils_chat 同样扣积分（实测一次约 180 tokens，成本与官方 API 相当）。
6. **学习边界**：本文仅用于技术研究/学习；商用/分发 TRAE API 能力有明确合规风险。

---

## 13. 学习要点总结

1. **加密不等于安全**：客户端加密 ≠ 服务端必须。逆向时先验证"明文通道是否被接受"，往往比破解加密便宜一个数量级。
2. **双通道思维**：信令(WS) 与数据(HTTP) 分离，先分清哪个承载真正的业务载荷。
3. **抓包优先级**：改配置禁用 QUIC/HTTPDNS + 系统根证书 MITM，比破解证书 pin 简单得多；先看"能不能解密"，再看"解密后值不值"。
4. **社区是宝藏**：`traework2api` 用 `llm_utils_chat` 而非 `create_agent_task`，绕开了原生层加密——选对通道比破解加密更重要。
5. **凭证分层**：设备级(access_key) / 会话级(JWT) / 消息级(X-Cylons) 分属不同安全层级，复现时只需最便宜的层级（JWT）。

---

## 14. pi 扩展落地（工程实现）

> ⚠️ 本节描述的是 **0.1.x 的初始落地架构**（双文件凭证：auth.json + trae-state.json）。
> 0.2.0 已重构为原生 `createProvider` + 单一 Pi OAuth credential，凭证/目录/命令均变化，
> 请以 `README.md` 与 `docs/trae-provider-maintenance.md` 为准。协议事实（通道、SSE 事件名、工具回传格式）不受重构影响。

交付：`~/.pi/agent/extensions/trae-provider/`（pi 原生 provider 扩展，无代理）

**架构**：`pi.registerProvider` + `oauth`（登录/刷新）+ `streamSimple`（自定义协议流式）

**登录自动化**（免手动复制链接）：
- login 时先在 `127.0.0.1:18080` 启动临时 HTTP 服务器
- 浏览器登录后 TRAE 自动回跳到该地址，服务器捕获 `refreshToken/userJwt/userInfo`
- 页面显示「✅ 登录成功」，自动 ExchangeToken → GetUserInfo → 凭证入库
- 端口占用/超时（3 分钟）自动回退到手动粘贴

**模型调用**：`streamSimple` 把 pi 的 Context 转成 `llm_utils_chat` 明文请求，解析 SSE（`output.response`→text、`reasoning_content`→thinking、`tool_calls`→pi ToolCall、`token_usage`→usage、`done`→stopReason）

**凭证生命周期**：refreshToken 由 pi 的 `oauth.refreshToken` 自动调用 ExchangeToken 轮换，JWT 14 天自动续期免维护

**已实测可用**：`glm-5.2`、`DeepSeek-V4-Flash-Official`；工具调用映射已实现（待 agent 场景实测）
