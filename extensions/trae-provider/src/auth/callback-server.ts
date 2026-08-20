// localhost 回调服务器：ready/result/close 生命周期。
// - waitUntilReady() 成功前不得发布 auth URL
// - 只接受预期路径；其他路径 404，不关闭 listener、不显示成功
// - 合法回调只 resolve 一次
// - close() 幂等，成功/失败/超时/取消都必须调用
import { createServer } from "node:http";
import type { Server } from "node:http";
import { abortError } from "../client/errors.ts";

const SUCCESS_HTML =
    `<!doctype html><html><meta charset="utf-8"><body style="font-family:sans-serif;text-align:center;padding-top:80px">` +
    `<h2>✅ 登录成功！</h2><p>授权已收到，可以关闭此页面，回到 pi。</p></body></html>`;

export interface CallbackServerOptions {
    port: number;
    path: string;
}

export class CallbackServer {
    readonly callbackUrl: string;
    private readonly port: number;
    private readonly path: string;
    private server?: Server;
    private readyPromise?: Promise<void>;
    private readonly callbackPromise: Promise<URL>;
    private resolveCallback!: (url: URL) => void;
    private rejectCallback!: (error: Error) => void;
    private closePromise?: Promise<void>;

    constructor(options: CallbackServerOptions) {
        this.port = options.port;
        this.path = options.path;
        this.callbackUrl = `http://127.0.0.1:${this.port}${this.path}`;
        let resolve!: (url: URL) => void;
        let reject!: (error: Error) => void;
        this.callbackPromise = new Promise<URL>((res, rej) => {
            resolve = res;
            reject = rej;
        });
        // listener 失败（如端口被占）会 reject callbackPromise；无人消费时也不能变成 unhandled rejection。
        this.callbackPromise.catch(() => {
            /* 供 waitForCallback 的 then 分支消费；此处仅为防 unhandledRejection */
        });
        this.resolveCallback = resolve;
        this.rejectCallback = reject;
    }

    private ensureServer(): void {
        if (this.server) return;
        const server = createServer((req, res) => {
            const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
            if (url.pathname === this.path) {
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                res.end(SUCCESS_HTML);
                this.resolveCallback(url); // 已 resolve 后再收到请求是 no-op
            } else {
                res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
                res.end("not found");
            }
        });
        server.on("error", (error: Error) => {
            this.rejectCallback(error);
        });
        server.listen(this.port, "127.0.0.1");
        this.server = server;
    }

    /** 等待 listener 就绪；端口被占/abort 时 reject。 */
    waitUntilReady(signal: AbortSignal): Promise<void> {
        if (!this.readyPromise) {
            this.ensureServer();
            const server = this.server!;
            this.readyPromise = new Promise<void>((resolve, reject) => {
                const onListening = () => {
                    cleanup();
                    resolve();
                };
                const onError = (error: Error) => {
                    cleanup();
                    reject(error);
                };
                const onAbort = () => {
                    cleanup();
                    reject(abortError(signal));
                };
                const cleanup = () => {
                    server.off("listening", onListening);
                    server.off("error", onError);
                    signal.removeEventListener("abort", onAbort);
                };
                if (server.listening) {
                    cleanup();
                    resolve();
                    return;
                }
                server.once("listening", onListening);
                server.on("error", onError);
                signal.addEventListener("abort", onAbort, { once: true });
                if (signal.aborted) onAbort();
            });
        }
        return this.readyPromise;
    }

    /** 等待合法回调；abort 时 reject。已 resolve 过的回调再次调用立即返回。 */
    waitForCallback(signal: AbortSignal): Promise<URL> {
        return new Promise<URL>((resolve, reject) => {
            const onCallback = (url: URL) => {
                cleanup();
                resolve(url);
            };
            const onReject = (error: Error) => {
                cleanup();
                reject(error);
            };
            const onAbort = () => {
                cleanup();
                reject(abortError(signal));
            };
            const cleanup = () => {
                signal.removeEventListener("abort", onAbort);
            };
            void this.callbackPromise.then(onCallback, onReject);
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) onAbort();
        });
    }

    /** 幂等关闭：即使 listen 仍在进行中也能正确回收（close 在 listen 完成后立即触发）。 */
    async close(): Promise<void> {
        if (!this.closePromise) {
            this.closePromise = new Promise<void>((resolve) => {
                const server = this.server;
                if (!server) {
                    resolve();
                    return;
                }
                const onClose = () => {
                    cleanup();
                    resolve();
                };
                const onError = () => {
                    cleanup();
                    resolve();
                };
                const cleanup = () => {
                    server.off("close", onClose);
                    server.off("error", onError);
                };
                server.once("close", onClose);
                server.once("error", onError);
                server.close();
                server.closeAllConnections?.();
            });
        }
        return this.closePromise;
    }
}
