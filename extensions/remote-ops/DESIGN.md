# Pi Remote Ops Extension Design

> 当前已实现：`remote_exec`（远程命令执行）。
> `download` / `upload` 文件传输工具 **尚未实现**，仅保留设计记录。

## 1. 目标

`remote-ops` 是 `pi-coding-agent` 的项目级远程运维扩展，通过 rp-proxy 在 Linux 服务器上执行诊断和运维命令，并提供生产环境安全策略（AST 校验、命令风险分级、自动/确认/阻止决策）。

## 2. 明确不做什么

- `download` / `upload` 文件传输（见 §7 设计草案，未实现）
- FTP / SFTP / FTPS 协议支持
- 远程工作区模式
- 在远端直接开发代码
- Kubernetes 能力
- 全局配置
- 在项目配置中保存密码、Token 或私钥

## 3. 设计原则

### 3.1 单一工具

对模型只暴露一个工具：`remote_exec`。

### 3.2 配置表达连接和操作边界

项目配置分为两层：

- `profiles`：远程主机 + token + cwd + 策略
- 每个 profile 指定 `host`、`port`、`token`、`cwd`、`policy`

### 4.3 实现

配置使用 `protocol` 字段；代码内部使用 Adapter：

```text
Tool -> Operation Service -> Adapter -> System Client
```

推荐命名：

- 配置：`protocol`
- 协议适配：`Adapter`
- 底层进程封装：`Client`，仅在确实需要时拆分

### 4.4 默认保守

- 只自动执行明确匹配只读白名单的简单命令
- 无法确认安全性的命令默认要求确认
- 任何配置、解析或协议能力不明确时失败关闭
- 不提供项目配置可放宽的自动执行规则

### 4.5 模型不能控制安全策略

以下行为不能由工具参数控制：

- 是否允许覆盖
- 是否需要确认
- 是否允许不安全 FTP
- TLS 证书校验
- SSH host key 校验
- 极高危命令放行
- 远端允许使用的 cwd

这些行为由扩展固定规则和项目 operation 配置共同决定。

## 7. Tool 契约

### 7. `remote_exec`

```ts
interface RemoteExecInput {
  profile: string;
  command: string; // input only; parsed before execution
  cwd?: string;
  timeout?: number;
}

interface VerifiedCommand {
  executable: string;
  executionPath: string;
  args: readonly string[];
}
```

语义：

- `profile` 来自 `operations.remote_exec`
- profile 只能引用 `protocol: "ssh"` 的 connection
- 命令默认在 operation 配置的远端 `cwd` 中执行；此字段表示**默认工作目录**，不是文件系统访问边界
- 工具参数 `cwd` 必须是相对于 operation cwd 的相对路径，且不允许通过该参数逃出 operation cwd
- 命令文本仍可引用绝对路径，是否可访问完全取决于远端 SSH 账号权限；若要隔离文件系统，必须在远端使用受限账号、容器/namespace 或 chroot
- `timeout` 不能超过 `maxTimeout`

返回 details：

```ts
interface RemoteExecDetails {
  profile: string;
  connection: string;
  host: string;
  cwd: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
}
```

远端命令返回非零退出码属于正常执行结果；SSH 连接、协议或启动失败才作为 tool error 抛出。

## 11. Remote Exec 执行模型

### 11.1 基础执行

- 使用系统 OpenSSH
- 每次 tool 调用执行一次 SSH exec
- 连接复用交给用户的 SSH Config / ControlMaster
- 不申请 TTY
- 远端 proxy 接收 `program + args + cwd`，使用 `exec`/`execve` 执行，不使用 `/bin/bash -c`
- 客户端先用 Bash AST 解析，只接受单个静态 `SimpleCommand`
- 变量/命令/算术展开、glob、brace/tilde expansion、管道、重定向、命令链、后台任务、赋值和嵌套解释器均阻止
- 不主动加载 root 登录脚本
- 不转发 Pi 本地进程环境变量
- 不进行本地 shell 拼接；执行层只接收 `VerifiedCommand` 的 argv

### 11.2 输出

- stdout 和 stderr 实时流式展示
- 输出按 Pi 规范截断到 50KB 或 2000 行
- 截断时明确提示
- 完整输出如需落盘，应写入扩展临时目录并使用尽可能严格的权限
- session custom entry 不重复保存完整输出

### 11.3 超时与取消

V1 需要远端进程组取消，而不仅是终止本地 SSH 客户端：

1. 每次执行生成 `runId`
2. 在远端独立进程组中运行命令
3. 在安全临时目录记录进程组 PID
4. 用户取消时发起第二次 SSH 请求
5. 先发送 TERM
6. 短暂等待后仍存活则发送 KILL
7. 完成后删除 PID 状态文件

需要阻止容易逃逸进程组控制的命令形式：

- `nohup`
- `disown`
- 显式 `setsid`
- 后台 `&`

即使采取进程组控制，扩展文档仍需声明：恶意或主动 daemonize 的命令可能逃逸，客户端取消不是操作系统级沙箱。

### 11.4 交互式命令

以下命令不通过 `remote_exec` 运行：

- vim / vi / nano
- top / htop 等交互 TUI
- less / more 等 pager
- 需要密码输入或 TTY 的程序

用户应使用：

```text
/remote-shell <remote_exec-profile>
```

## 12. 命令风险策略

### 12.1 策略模式

V1 内置：

```text
read-only
confirm-write
confirm-all
```

语义：

- `read-only`：只允许明确只读白名单，其他命令阻止
- `confirm-write`：明确只读白名单自动执行，其他命令确认，极高危命令阻止
- `confirm-all`：除极高危命令外全部确认

不提供 `allow-all`。

项目配置只能选择内置策略，并可以增加更严格的确认或阻止规则；不能把新命令添加到自动执行白名单。

### 12.2 判断顺序

```text
极高危阻止规则
  -> 敏感读取确认规则
  -> 严格只读白名单
  -> 其他全部确认
```

### 12.3 自动只读命令

只允许结构简单、无 Shell 控制操作符且明确只读的命令模式，例如：

- pwd
- whoami
- id
- hostname
- uname
- uptime
- date
- df
- free
- ps
- pgrep
- ss
- ls
- stat
- file
- head
- tail
- grep
- rg
- sha256sum

带子命令的工具使用子命令级白名单，例如：

- `systemctl status/show/is-active/is-enabled`
- `journalctl` 的查询模式
- `docker ps/logs/stats/version/info`
- `docker compose ps/logs/config`

不能仅根据可执行文件名判断安全性。

### 12.4 默认确认与直接阻止

以下静态、可理解的命令形式默认确认：

- 不匹配严格只读白名单
- cp、mv、install、chmod、chown
- systemctl start/stop/restart
- Docker 创建、更新、重启和删除操作
- Git 更新
- 软件安装
- curl、wget
- 配置文件修改

以下命令形式不进入确认流程，直接阻止：

- 复杂或未知 AST 节点（多行命令、管道、重定向、后台任务、命令链等）
- 变量展开、命令替换、算术展开、glob、brace/tilde expansion、动态路径
- cp、mv、install、chmod、chown
- systemctl start/stop/restart
- Docker 创建、更新、重启和删除操作
- Git 更新
- 软件安装
- curl、wget
- 配置文件修改

### 12.5 极高危阻止

建议 V1 直接阻止：

- `rm -rf`
- mkfs、dd、wipefs
- shutdown、reboot、poweroff
- 用户、组和密码修改
- SSH 授权与 sshd 配置修改
- 防火墙、路由和磁盘分区修改
- `curl | sh`、`wget | bash`
- 递归修改根目录权限
- 删除 Docker volume 或大范围 prune

这类命令只能通过人工 `/remote-shell` 执行。

### 12.6 敏感读取确认

以下读取即使不修改服务器也确认：

- `/etc/shadow`
- `/root/.ssh`
- `.env`
- `/proc/*/environ`
- 云服务凭证目录
- env、printenv
- 明显可能包含密码、Token 或私钥的配置

原因是远端输出会进入模型上下文和 Pi session。

## 13. Shell 重定向规则

风险判断必须识别未被引号包裹的 Shell 语法，不能简单使用字符串包含判断。

### 13.1 Echo

以下简单输出可自动执行：

```bash
echo hello
```

以下直接阻止：

```bash
echo hello > file
echo hello >> file
echo "$TOKEN"
echo "$(some-command)"
```

### 13.2 输出重定向

以下均视为写操作：

- `>`
- `>>`
- `>|`
- `2>`
- `2>>`
- `&>`
- `&>>`

当前 AST 子集不接受任何重定向，包括指向 `/dev/null` 的重定向。需要丢弃输出时，应由工具/适配器层处理，而不是把重定向写进命令。

### 13.3 非重定向写入

风险检测还必须识别：

- `tee`
- `tee -a`
- `sed -i`
- `find -delete`
- `find -exec`
- `install`

### 13.4 高危写入路径

建议直接阻止写入：

- `/root/.ssh/authorized_keys`
- `/etc/passwd`
- `/etc/shadow`
- `/etc/sudoers` 及其 include 目录
- `/etc/ssh/`
- `/dev/sd*`
- `/proc/sys/`
- `/sys/`

其他 `/etc` 写入要求确认。

### 13.5 解析失败

- Shell 解析失败时不执行自动放行
- `confirm-write` 下进入确认
- `read-only` 下阻止
- 不尝试通过模型提供的“这是安全命令”说明覆盖解析结果

## 14. 项目信任与 Connection 首次批准

### 14.1 项目信任

扩展是全局加载的，但配置只来自项目：

```text
.pi/remote-ops.json
```

扩展应在 `project_trust` 阶段检测该文件：

- 未信任时不读取 connection、host 或环境变量名
- 用户拒绝信任时远程工具保持禁用
- 非交互模式没有已保存信任或显式批准时禁用远程工具

### 14.2 Session 首次使用批准

即使项目已经可信，每个 connection 在每个 Session 首次使用时仍需确认：

```text
Allow project remote connection?

Connection: prod-server
Protocol: ssh
Host: prod-api

Used by:
- remote_exec.production
```

批准只在当前 Session 内有效。

连接批准不替代 operation 自身确认：

- remote_exec 修改命令：仍每次确认

非交互模式无法弹出首次 connection 确认，因此 V1 默认阻止实际远程操作。

## 16. UI 与命令

### 16.1 工具渲染

默认显示：

- operation profile
- protocol
- host
- 源路径和目标路径
- 文件大小
- SHA-256
- 是否覆盖
- 命令风险原因
- 执行耗时和退出码

不展示：

- 密码
- 环境变量值
- 私钥路径
- 完整认证参数

### 16.2 `/remote-init`

在当前项目创建：

```text
.pi/remote-ops.json
```

行为：

- 使用 `wx` 创建，绝不覆盖已有配置
- 写入合法的 localhost 起始模板，包含 `remote_exec` example profile
- `remote_exec` 示例默认使用 `confirm-all`
- 显式用户命令可批准该模板在当前 Session 内加载
- 提示用户替换 connection alias、transfer 的远端根目录及 remote_exec 的默认工作目录（均使用 `cwd` 字段）后执行 `/remote-status`

### 16.3 `/remote-status`

展示：

- 配置路径
- 配置版本和校验状态
- connections
- operation profiles
- 缺失的环境变量
- 当前 Session 已批准的 connections
- 暂停或禁用原因

### 16.4 `/remote-doctor`

```text
/remote-doctor
/remote-doctor <remote_exec-profile>
/remote-doctor setup-ssh
```

行为：

- 无参数时检查本机 `ssh`、`ssh-keygen`、`.ssh` 目录、SSH 配置、常见私钥和项目配置，并输出 Windows -> Linux/WSL 的完整配置步骤
- 带 profile 时解析 `ssh -G`，检查 `BatchMode` 远端连通性、Linux、`remote_exec.cwd`、Bash 和可选 curl
- `setup-ssh` 通过 UI 收集 alias、主机、用户、端口和可选 `IdentityFile`
- 写入前展示完整 `Host` 段并要求确认；只允许追加新 alias，拒绝覆盖同名 Host
- 不自动生成密钥，不修改远端 `sshd`、用户、`authorized_keys`、防火墙或项目配置
- 认证、known_hosts、DNS、端口、sshd 未运行和远端前置条件失败时，输出对应修复路径

### 16.5 `/remote-shell`

```text
/remote-shell <remote_exec-profile>
```

行为：

- 仅 TUI 模式可用
- profile 必须引用 SSH connection
- 首次使用 connection 时确认
- 暂停 Pi TUI
- 启动人工交互式 SSH shell
- 退出后恢复 Pi TUI
- 不创建模型 bridge、反向转发或远端 `@pi` helper
- shell 内容不发送给模型

### 16.6 实验性 `/remote-shell-pi` 与 `@pi`

```text
/remote-shell-pi <remote_exec-profile>
@pi <question>
``` 

`@pi` 只通过显式的 `/remote-shell-pi` 入口启用，作为实验性能力保留。普通 `/remote-shell` 不依赖 Bash 或 `curl`；实验性入口要求 Bash、`curl` 和当前 Pi model。

`@pi` 的数据流：

```text
远端 Bash 函数 + 环境快照
  -> curl 127.0.0.1:<remote-forward-port>
  -> SSH -R loopback reverse forwarding
  -> 本机 127.0.0.1 临时 HTTP bridge
  -> 当前 Pi model 的隔离无工具内存会话
```

约束：

- bridge 只监听本机 `127.0.0.1`，每次 shell 使用随机 Bearer token
- SSH reverse forward 只绑定远端 `127.0.0.1`，并启用 `ExitOnForwardFailure=yes`
- 每个 `@pi` 请求自动附加远端当前 `$PWD`、用户、主机名、`/etc/os-release`、内核/架构、Bash 版本和 PID 1
- `@pi` 不发送本机 Pi/project 环境、主会话上下文、远端 stdout、项目文件或完整环境变量
- 本地 bridge 使用进入 shell 时选中的 model 和 thinking level 创建隔离内存会话；仅保存当前 shell 内的 `@pi` 问答，不创建或修改主 Pi Session
- 模型没有工具、用户/项目扩展、技能或项目上下文，不能执行远端命令；系统提示要求它按远端 Linux 环境给出建议，并输出适合终端的纯文本
- 远端函数将 curl 放入后台并显示 `@pi thinking | / -` spinner；请求结束后清理状态行再输出回答
- bridge 返回前移除 Markdown 标题、粗斜体、代码围栏、行内代码、链接和表格边界；保留代码内容、缩进、列表和段落换行
- SSH 退出后关闭 bridge 并销毁隔离 AgentSession
- 这不是 `remote_exec` 的替代路径；`@pi` 只能问答，不能调用 Remote Ops 或 Pi 工具

### 16.7 Footer

建议状态保持简洁：

- `remote-ops: 2 connections`
- `remote-ops: config error`
- 工具执行期间临时显示 profile 和 host

不存在隐藏的“当前活动连接”，因此不显示长期 active target。

## 17. 审计与 Session 状态

V1 不额外创建独立审计日志文件，避免命令和路径在项目中重复泄露。

通过 Pi session custom entry 保存必要元数据：

- operation 和 profile
- connection、protocol、host
- 用户批准或拒绝
- 本地及远端目标路径
- 文件大小和 SHA-256
- 命令风险分类
- 命令退出码和耗时
- 是否超时、取消或截断

`@pi` 的问题和回答不写入主 Pi session custom entry，也不在 bridge 中写入独立日志文件。

不在 custom entry 中保存：

- 密码和 Token
- 环境变量值
- 完整远端输出
- 重复的文件内容

Session 恢复时不恢复 connection 批准状态，新的运行进程必须重新确认。
