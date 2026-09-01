import { appendFileSync, readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import nativeChildProcess from "node:child_process?native";
import * as nativeExports from "node:child_process?native";
import { PassThrough, Writable } from "node:stream";

export * from "node:child_process?native";
export { nativeChildProcess as default };

type FakeChild = EventEmitter & {
  stdin: Writable;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: () => boolean;
};

export function spawn(_command: string, _args: string[], _options: unknown): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

  const counterPath = process.env.CODEX_QUOTA_COUNTER;
  const delayMs = Number(process.env.CODEX_QUOTA_FAKE_CURL_DELAY_MS ?? "250");
  const mode = process.env.CODEX_QUOTA_FAKE_CURL_MODE ?? "failure";

  // "fail-once"：首次请求失败、后续成功，用于验证失败后的自动退避重试能恢复。
  const priorRequests = counterPath
    ? (() => {
      try {
        return readFileSync(counterPath, "utf-8").trim().split("\n").filter(Boolean).length;
      } catch {
        return 0;
      }
    })()
    : 0;
  const succeed = mode === "success" || (mode === "fail-once" && priorRequests > 0);
  if (counterPath) appendFileSync(counterPath, "request\n", "utf-8");
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const finish = (code: number) => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    child.stdout.end();
    child.stderr.end();
    child.emit("close", code);
  };

  child.kill = () => {
    if (closed) return false;
    finish(-1);
    return true;
  };
  timer = setTimeout(() => {
    if (succeed) {
      child.stdout.write(JSON.stringify({
        rate_limit: {
          primary_window: { used_percent: 24, limit_window_seconds: 18_000 },
        },
      }));
      setImmediate(() => finish(0));
    } else {
      finish(22);
    }
  }, delayMs);

  return child;
}
