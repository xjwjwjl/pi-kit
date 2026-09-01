import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [agentDir, donePath, scenario] = process.argv.slice(2);
if (!agentDir || !donePath || !["session-start", "credential-changed", "retry"].includes(scenario ?? "")) {
  process.exitCode = 2;
} else {
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const { default: codexQuota } = await import("../index.ts");
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void | Promise<void>>();
  const eventHandlers = new Map<string, () => void>();
  let ctx: unknown;
  let finished = false;

  const finish = (status: string | undefined) => {
    if (finished) return;
    finished = true;
    writeFileSync(donePath, JSON.stringify({ status }), "utf-8");
    handlers.get("session_shutdown")?.({}, ctx);
    setTimeout(() => process.exit(0), 0);
  };

  ctx = {
    hasUI: false,
    ui: {
      setStatus(_key: string, status: string | undefined) {
        if (status?.includes("%")) finish(status);
      },
      theme: { fg: (_color: string, text: string) => text },
    },
  };

  codexQuota({
    on(event: string, handler: (event: unknown, c: unknown) => void | Promise<void>) {
      handlers.set(event, handler);
    },
    events: {
      on(name: string, handler: () => void) {
        eventHandlers.set(name, handler);
      },
    },
  } as never);

  const sessionStart = handlers.get("session_start");
  if (!sessionStart) {
    process.exitCode = 3;
  } else {
    const originalDateNow = Date.now;
    // 把当前时间拨到刚过 5 分钟边界的位置：边界定时器约 5 分钟后才触发，
    // 因此额度状态到达只能来自 session_start / credential-changed 的立即刷新，
    // 或 retry 场景下退避定时器在 ~5s 后触发的自动重试，而不是边界定时器。
    const now = originalDateNow();
    const refreshMs = 5 * 60 * 1000;
    const currentBoundary = Math.floor(now / refreshMs) * refreshMs;
    Date.now = () => currentBoundary + 10;
    try {
      await sessionStart({}, ctx);
      if (scenario === "credential-changed") {
        const credentialChanged = eventHandlers.get("openai-codex:credential-changed");
        if (!credentialChanged) {
          process.exitCode = 4;
        } else {
          // 会话启动时 auth.json 为空，不应产生请求；写入凭据后触发事件应引起立即刷新。
          await new Promise((resolve) => setTimeout(resolve, 400));
          writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
            "openai-codex": {
              type: "oauth",
              access: "test-access-token",
              refresh: "test-refresh-token",
              expires: originalDateNow() + 60 * 60 * 1000,
            },
          }), "utf-8");
          credentialChanged();
        }
      }
    } finally {
      Date.now = originalDateNow;
    }

    // 保持 ref 状态，否则 retry 场景在退避等待期间（~5s）进程会因事件循环排空而提前退出。
    const watchdog = setTimeout(() => {
      appendFileSync(donePath, "watchdog timeout\n", "utf-8");
      process.exit(4);
    }, scenario === "retry" ? 8_000 : 4_000);
  }
}
