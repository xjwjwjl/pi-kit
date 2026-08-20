// 统一 HTTP 出口：所有 TRAE 网络调用（聊天、积分、OAuth）都经过 TraeClient。
// fetch 可注入（测试用 mock），透传 signal / timeoutMs / onResponse。
import type { FetchFunction, ProviderResponse } from "@earendil-works/pi-ai";
import { TraeHttpError, httpErrorFromResponse } from "./errors.ts";

export interface TraeClientOptions {
    fetchFn?: FetchFunction;
}

export interface TraeRequestOptions {
    url: string;
    body: unknown;
    headers: Record<string, string>;
    signal?: AbortSignal;
    timeoutMs?: number;
    onResponse?: (response: ProviderResponse) => void | Promise<void>;
}

export class TraeClient {
    private readonly fetchFn: FetchFunction;

    constructor(options: TraeClientOptions = {}) {
        this.fetchFn = options.fetchFn ?? globalThis.fetch;
    }

    /** JSON 请求；非 2xx 或非法 JSON 均抛错，绝不把坏响应当成功。 */
    async requestJson<T>(request: TraeRequestOptions): Promise<T> {
        const response = await this.doFetch(request);
        const text = await readLimitedText(response, 4096);
        if (!response.ok) throw httpErrorFromResponse(response.status, text);
        try {
            return JSON.parse(text) as T;
        } catch {
            throw new TraeHttpError(response.status, `TRAE 响应不是合法 JSON（HTTP ${response.status}）`);
        }
    }

    /** 流式请求；仅在 2xx 时返回 Response，非 2xx 抛出脱敏错误。 */
    async requestStream(request: TraeRequestOptions): Promise<Response> {
        const response = await this.doFetch(request);
        if (!response.ok) {
            const text = await readLimitedText(response, 4096);
            throw httpErrorFromResponse(response.status, text);
        }
        return response;
    }

    private async doFetch(request: TraeRequestOptions): Promise<Response> {
        let signal = request.signal;
        if (request.timeoutMs !== undefined && request.timeoutMs > 0) {
            signal = signal
                ? AbortSignal.any([signal, AbortSignal.timeout(request.timeoutMs)])
                : AbortSignal.timeout(request.timeoutMs);
        }
        const response = await this.fetchFn(request.url, {
            method: "POST",
            headers: request.headers,
            body: JSON.stringify(request.body),
            signal,
        });
        if (request.onResponse) {
            await request.onResponse({ status: response.status, headers: headersToRecord(response.headers) });
        }
        return response;
    }
}

function headersToRecord(headers: Headers): Record<string, string> {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
        out[key] = value;
    });
    return out;
}

/** 非 2xx 诊断：最多读取 limit 字节，避免吞掉大响应。 */
async function readLimitedText(response: Response, limit: number): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            const remaining = limit - total;
            if (remaining <= 0) break;
            chunks.push(value.length <= remaining ? value : value.subarray(0, remaining));
            total += Math.min(value.length, remaining);
            if (total >= limit) break;
        }
    } finally {
        reader.releaseLock();
    }
    return new TextDecoder().decode(concatBytes(chunks));
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
    let length = 0;
    for (const chunk of chunks) length += chunk.length;
    const out = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}
