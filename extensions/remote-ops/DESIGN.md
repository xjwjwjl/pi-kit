# Remote Ops 执行与安全规范

本文描述当前本地源码中的执行路径和边界，不代表真实服务器联调或安全验收完成。现行用法见 [README.md](./README.md)。

## 1. 范围与配置

仅暴露 `remote_exec`；仅注册 `/remote-init`、`/remote-status`、`/remote-doctor [profile]`。不提供交互 shell、SSH 配置管理、模型 bridge、远程工作区、远端代码开发、Kubernetes 或全局主机配置。

文件上传/下载及 FTP/SFTP/FTPS 不在当前实现范围；文件传输是待设计提案，没有已实现工具或接口契约。

项目配置固定来自当前 cwd 的 `.pi/remote-ops.json`：

- 根字段仅 `version: 3`、`profiles`；空 profiles 合法。
- 每个 profile 必填 `host`、`port`、`token`、`cwd`、`policy`；可选 `description`、`defaultTimeout`、`maxTimeout`。未知字段拒绝；没有 connection/operation 分层或 protocol 选择。
- 名称匹配 `[A-Za-z0-9][A-Za-z0-9._-]*`；description 为最多 240 字符的非空单行文本。
- host/token 为非空字符串；port 为 1–65535 整数；cwd 为绝对 POSIX 路径。超时为正整数秒，显式 defaultTimeout 不得超过 maxTimeout。
- loader 只支持额外剥除 `//` 行注释；不展开环境变量、不从密钥库取 token。token 以明文存储，必须限制配置文件权限并避免提交真实凭证。
- 配置不能添加自动执行白名单、放行被阻止的命令，工具参数不能选择策略或绕过确认。

`/remote-init` 使用 `wx` 创建，不覆盖已有文件；新模板包含完整的 production profile、9090 端口、占位 token、`/root` cwd、60/1800 秒超时和 `confirm-all`。新建模板被当前 session 批准加载，并非已经可用的连接。已加载配置编辑后用 `/reload` 重载；`/remote-status` 不保证重新读取磁盘文件。

## 2. 工具与执行链

```text
remote_exec({ profile, command, cwd?, timeout? })
  -> RemoteOpsExtensionRuntime
  -> RemoteOpsService（路径、超时、风险、批准）
  -> HttpProxyAdapter
  -> POST http://host:port/exec
  -> Linux piexec：exec.CommandContext(program, args...)
```

profile 必须是 `profiles` 的准确名称。每轮模型目录最多列出 20 个 profile，含 description、host/port、cwd、policy，不含 token；远程意图路由不构成安全批准。

### AST → verified argv

客户端 `shell-parser.ts` 使用 unbash AST，只接受一个静态简单命令，生成不可变的：

```ts
interface VerifiedCommand {
  executable: string;       // 策略判断的命令名
  executionPath: string;    // 实际发送的名称或受限绝对路径
  args: readonly string[];
}
```

- 原始命令最多 4096 UTF-8 字节；最多 100 个参数；每个词最多 1024 字节；拒绝 NUL 和指定控制字符。
- 阻止多行、管道、命令链、分号、后台执行、子 shell、赋值、所有重定向及非简单 AST；解析失败一律阻止，不能靠确认放行。
- 阻止变量/命令/算术展开、进程替换、ANSI-C 等不支持的引用，以及未引用的 glob、brace/tilde expansion。引号内纯字面量（如 `echo "| *.log"`）可接受，不重新解释为 shell 语法。
- 可执行文件必须在内置目录表中；只允许裸名称或 `/usr/bin/`、`/bin/`、`/usr/sbin/`、`/sbin/`、`/usr/local/bin/`、`/usr/local/sbin/` 下的直接文件。相对可执行路径、任意脚本路径和未知程序均阻止。
- 嵌套解释器等即使能解析为 argv，也在策略层阻止。执行层只接收 verified argv，不拼接本地 shell，也不调用远端 `bash -c`。

### cwd 与进程权限

profile cwd 是默认起始目录，**不是文件系统访问边界**。工具 cwd 若提供，须为相对 POSIX 路径，经词法规范化后不能逃出 profile cwd；不做远端 realpath/symlink 隔离。命令参数仍可引用任意绝对路径、`..` 或符号链接，实际权限由 piexec 运行账号决定。

piexec 不加载登录脚本，不转发 Pi 本地环境；子进程环境固定为 PATH、`LANG=C`、`LC_ALL=C`。远端账号、程序目录所有权、容器/namespace/chroot 等隔离由部署方负责；AST 与路径规则都不是 OS 沙箱。

## 3. 风险决策

处理顺序：AST/可执行目录验证 → 首个匹配的命令规则 → 无条件阻止 → 对识别出的写操作检查保护路径 → 对原本自动的读取检查敏感路径 → 应用 policy。命令目录中存在但没有匹配规则的程序同样阻止，不是“其他全部确认”。

| policy | 基础 auto | 基础 confirm | 基础 block / 解析失败 |
| --- | --- | --- | --- |
| `read-only` | 自动 | 阻止 | 阻止 |
| `confirm-write` | 自动 | 每次确认 | 阻止 |
| `confirm-all` | 每次确认 | 每次确认 | 阻止 |

没有 `allow-all`，确认也不覆盖 block。

### 自动候选与确认候选

以下是现行规则摘要，不是所有选项都已证明只读的承诺；精确判定以 `command-policy.ts`、`cmd-parsers.ts`、`path-guard.ts` 为准。

- 常见 auto 候选：pwd、whoami、id、uname、uptime、df、free、ps、pgrep、ls、stat、file、head、tail、grep、rg、cat、sha256sum、echo、printf、du、wc 等内置命令。
- date 只读参数、hostname 查询、磁盘检查有单独参数规则；`date -s/--set` 阻止，其他非只读 date/hostname 参数可能要求确认。
- `systemctl status/show/is-active/is-enabled` 是 auto 候选；其他非电源子命令通常确认。远程/alternate-root target 参数及 poweroff/reboot/halt/suspend/hibernate 阻止。
- journalctl 查询可自动；文件/目录选项、维护操作确认；识别出的 follow/watch 参数阻止。tail 同样阻止识别出的 follow/watch。
- Docker `ps/version/info`、Compose `ps/config` 可自动；logs 有 `--tail`/`-n`/`--since`/`--until` 等限制参数才是 auto 候选，无限制则确认；stats 要求 `--no-stream`。run/exec/build 阻止，识别出的 system/volume/network/container 删除或 prune 阻止；start/stop/restart/pull/push/create/rm/update/cp 等已列状态操作确认，未知操作阻止。
- ss 查询可自动；`-K/--kill` 阻止，诊断输出/外部过滤文件选项确认。ip 查询可自动；识别出的网络修改、batch、exec、monitor 阻止。
- cp、mv、mkdir、touch、chmod、chown、ln、install、tee、truncate、sed、mount、umount、kill/pkill/killall、service、curl、wget 属确认候选，不是普遍禁止。rm 未同时带 recursive 和 force 时确认。
- stdin 读取规则识别到的 cat/head/tail/grep/rg/sha256sum/wc 输入阻止；less/more 阻止。工具没有 TTY、交互输入或内置人工 shell 入口。

### 无条件高危阻止与路径规则

- shell/env/eval/source/exec、xargs/find、Python/Perl/Ruby/Node、ssh/sudo/doas、systemd-run、nohup/disown/setsid 等间接执行入口阻止。
- 主机电源命令、mkfs 系列/dd/wipefs、用户/组/密码修改、ufw/iptables/nft/firewall-cmd/route 阻止；fdisk/parted/hdparm 等仅匹配到检查参数时自动，否则阻止。
- rm 同时带 recursive 和 force（含拆分/长选项及识别出的附着路径形式）阻止。
- 对识别出的写路径操作数，保护 `.ssh/authorized_keys`、`/etc/passwd`、`/etc/shadow`、`/etc/sudoers` 及 include 目录、`/etc/ssh`、`/dev/sd*` 对应规则、`/proc/sys`、`/sys`。
- 敏感读取规则对指定读取命令的路径参数检查 `/etc/shadow`、`/etc/passwd`、SSH/sudoers 配置、`.ssh`、`.aws`、`.config/gcloud`、`/proc/*/environ`、`.env`/`.env.*`，将 auto 升为 confirm；`read-only` 因而阻止。匹配到环境输出形式的 ps 参数也要求确认；env 本身是阻止项。

路径检测是词法规范化与部分命令操作数提取，不是完整文件访问监控；不解析远端符号链接或所有程序的选项语义。不能据此承诺所有 SSH 配置变更、递归权限修改、敏感配置读取或副作用均被拦截。命令被阻止时应展示原因，不重试绕过策略；有需要的人工操作应在本扩展之外独立进行。

## 4. 信任、批准与并发

- 未信任项目启动时只检查配置存在性，不加载 profile/host/token。个人/显式加载的扩展可在 `project_trust` 询问临时信任；拒绝后不自动启用远程工具。
- 执行入口可单独询问是否批准读取配置用于当前 session；无 UI 且未可信/批准则拒绝。`/remote-status` 不主动弹出此批准。
- `remote_exec` 通过风险检查后，还须首次 hostname 批准。批准集合仅用 `host` 字符串作 key：同 host 的不同 profile、port、token 共享批准，不是每个连接凭证分别批准。
- 每次 confirm 风险操作仍单独询问；首次 hostname 批准不替代命令确认。即使项目可信，无 UI 也无法完成首次 host 批准，实际执行因而拒绝。
- 批准仅在 service 内存中，session 开始或扩展重载后重建；不从 Pi session 记录恢复。并发同 host 的首次批准共用一次待决请求。
- 需要确认的执行按 host 排队；auto 执行不排队。队列不是远端跨客户端锁，也不能保证取消尚在排队中的任务。

## 5. HTTP 协议与服务端边界

当前工厂只创建 `HttpProxyAdapter`，URL 固定为 `http://host:port`，以 `Authorization: Bearer <token>` 认证：

- `GET /health` 返回 status、hostname、os、pid。
- `POST /exec` 请求字段为 program、args、cwd、timeout；响应为 exitCode、stdout、stderr、timedOut。没有独立 runId、cancel 或流式输出接口。
- Linux piexec 校验程序目录/禁止集合、可执行权限、symlink 解析后的路径范围，以及参数数量、长度、控制字符。请求读取限制为 32 KiB，timeout 默认 60、上限 3600 秒。
- 裸程序名按固定系统目录查找；symlink 解析后还可位于指定 lib/libexec 目录。程序目录的可信性仍依赖部署环境。
- 非零进程退出码是正常工具结果；连接失败、HTTP 非成功、协议/启动失败作为 tool error。响应没有取消确认字段。

**客户端风险策略不是服务端权限控制。** piexec 没有复刻客户端完整的风险表、项目策略、保护路径或用户批准；持有 token 的调用者不能被认为受客户端策略约束。

当前没有 HTTPS/TLS、证书校验或项目级网络目标限制；服务端监听 `:<port>`，不是 loopback-only。应限制监听端口的网络可达性、使用受保护通道与低权限账号、妥善管理 token；不能把明文 HTTP 的 bearer 认证描述为加密或已验收的安全部署。

`/remote-doctor` 无参数只检查配置存在性并给出指引；带 profile 会按配置读取批准流程后直接探测 `/health`（fetch 配置 5 秒 abort timer），不调用执行工具的首次 host 批准。它不验证远端 cwd、程序可用性或执行/取消能力，也不修改本地 SSH、远端账号或服务配置。源码部分 UI/报错仍有旧 SSH/交互 shell 文案，不代表存在对应实现。

## 6. 超时与取消的实际边界

- 超时取工具参数 → profile.defaultTimeout → 60 秒；若超过配置的 maxTimeout，客户端拒绝，不静默裁剪。配置可省略 maxTimeout，但 piexec 仍拒绝超过 3600 秒的请求。
- runtime 使用 `ctx.signal` 传给 adapter；adapter 合并该 signal 与本地 timeout 的 AbortController。超时/取消 abort fetch，并可能仅返回 exitCode=null 的本地状态，不提供远端退出证明。
- Linux 服务端从 HTTP request context 派生 timeout，用 `Setpgid: true` 启动进程；context 结束分支尝试向进程组发 SIGKILL 并关闭输出管道。没有原 SSH 设计中的第二条请求、PID 状态文件、TERM→KILL 宽限或取消确认协议。
- HTTP 断连到服务端 context 取消的传播、进程组回收与客户端状态的端到端一致性未在此处验收。主动 daemonize/脱离进程组的后代可能逃逸；客户端停止等待不等于远端操作已停止，更不等于回滚已产生的副作用。

## 7. 输出、审计与 secret 风险

- 服务端等待执行结束后返回 JSON；Pi 只收到起始/运行提示及最终结果，不实时显示远端 stdout/stderr。adapter 将 stdout 后接 stderr，不能恢复原始交错顺序。
- piexec 对 stdout/stderr 各保留开头最多 64 KiB，超出附加截断提示；各自最多 16 KiB 同时写入服务器控制台。命令及参数也打印到服务器控制台，可能由服务管理器另行持久化。
- 客户端对已接收合并输出保留末尾最多 2000 行/50 KiB，再附截断提示。details.truncated 只表示客户端这一层；不能代表服务端未截断，也没有完整输出临时文件供恢复。
- 执行返回后追加 `remote-ops-operation` custom entry，包含 profile、host、格式化命令、argv、cwd、风险原因、退出码、elapsed、timeout/cancel/truncation 与敏感模式元数据，不重复保存完整输出。批准/拒绝及抛错路径没有独立完整审计事件；不是完整审计账本。
- 扩展不另建审计日志文件，但普通 tool content 会进入模型上下文及 Pi session。custom entry 中的命令/argv、服务器日志、配置、profile description 都可能泄露秘密；服务端启动参数中的 token 还可能暴露在进程列表或 shell 历史中。
- secret scanner 仅扫描客户端截断后的文本，识别私钥、AWS key、凭证赋值、带凭证 DB URL、Bearer/Authorization 等部分模式，并写入 details.sensitive。**不脱敏、不阻止、不保证检出**；不能声称 token 从所有输出和日志中移除。

## 8. 尚未验收的边界

本规范仅按本地 schema/runtime/adapter/protocol、Go 源码与现有测试断言核对；不以测试文件存在代替测试通过或部署验证。安全部署（尤其传输保密、token 管理、服务端权限）、真实大输出行为和端到端超时/取消仍需独立验收；TLS 与专用远端取消协议当前未提供。文件传输仍未实现、待设计，不据旧施工记录承诺能力。
