import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import type { TestContext } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionEvent,
} from "@earendil-works/pi-coding-agent";
import register from "../index.ts";

type ExtensionMode = ExtensionContext["mode"];
type Handler = (event: any, ctx: ExtensionContext) => unknown;

export type MetadataReport = {
  binary: string;
  args: string[];
  complete: (error?: Error) => void;
};

export function createExtensionHarness(
  t: TestContext,
  options: { mode?: ExtensionMode; herdr?: boolean; manualReports?: boolean } = {},
) {
  const envKeys = ["HERDR_ENV", "HERDR_BIN_PATH", "HERDR_PANE_ID"] as const;
  const savedEnv = envKeys.map((key) => [key, process.env[key]] as const);
  process.env.HERDR_ENV = options.herdr === false ? "0" : "1";
  process.env.HERDR_BIN_PATH = "/mock/herdr";
  process.env.HERDR_PANE_ID = "w-test:p-test";

  const reports: MetadataReport[] = [];
  t.mock.method(childProcess, "execFile", (...args: any[]) => {
    const [binary, argv, , callback] = args;
    const report: MetadataReport = {
      binary,
      args: [...argv],
      complete: (error) => callback(error ?? null, "", ""),
    };
    reports.push(report);
    if (!options.manualReports) queueMicrotask(() => report.complete());
    return new childProcess.ChildProcess();
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const mode = options.mode ?? "tui";
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    signal: undefined,
    isIdle: () => true,
  } as unknown as ExtensionContext;
  const handlers = new Map<string, Handler>();
  const emitted: Array<{ channel: string; data: unknown }> = [];
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    events: {
      emit: (channel: string, data: unknown) => emitted.push({ channel, data }),
    },
  } as unknown as ExtensionAPI;

  register(pi);
  return {
    ctx,
    handlers,
    emitted,
    reports,
    emit: async (type: ExtensionEvent["type"], data: Record<string, unknown> = {}) => {
      await handlers.get(type)?.({ type, ...data }, ctx);
    },
  };
}

export function stateLabels(report: MetadataReport): Record<string, string> {
  const labels: Record<string, string> = {};
  for (let i = 0; i < report.args.length; i++) {
    if (report.args[i] !== "--state-label") continue;
    const value = report.args[++i];
    const separator = value.indexOf("=");
    labels[value.slice(0, separator)] = value.slice(separator + 1);
  }
  return labels;
}
