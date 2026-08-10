export function createRemoteOpsConfigTemplate(): string {
	return String.raw`{
  "version": 3,
  "profiles": {
    "production": {
      // 用途描述，帮助 AI 路由
      "description": "生产服务器诊断与运维",
      // piexec 所在 IP 或主机名
      "host": "192.168.1.10",
      // piexec 监听端口
      "port": 9090,
      // piexec Bearer token（生成：openssl rand -hex 32）
      "token": "change-me-to-a-random-hex-string",
      // 命令默认工作目录
      "cwd": "/root",
      // 命令默认超时秒数（可选）
      "defaultTimeout": 60,
      // 命令最大超时秒数（可选）
      "maxTimeout": 1800,
      // 安全策略：read-only | confirm-write | confirm-all
      "policy": "confirm-all"
    }
  }
}
`;
}
