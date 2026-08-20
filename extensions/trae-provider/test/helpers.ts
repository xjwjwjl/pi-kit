// 共享测试工具：模型 fixture、SSE 响应构造、事件收集。
import type { Model } from "@earendil-works/pi-ai";
import type { TraeApi } from "../src/model-catalog.ts";

export function makeModel(): Model<TraeApi> {
    return {
        id: "DeepSeek-V4-Flash-Official",
        name: "DeepSeek-V4-Flash-Official",
        api: "trae-llm-utils-chat",
        provider: "trae",
        baseUrl: "https://trae-api-cn.mchost.guru",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 384000,
    };
}

export interface SseFrameInput {
    event: string;
    data: string;
}

export function sseBytes(frames: SseFrameInput[]): Uint8Array {
    const text = frames.map((f) => `event: ${f.event}\ndata: ${f.data}\n\n`).join("");
    return new TextEncoder().encode(text);
}

/** 构造 SSE Response；chunkSize>0 时按字节分片发送（测试分块边界）。 */
export function sseResponse(frames: SseFrameInput[], chunkSize = 0): Response {
    const bytes = sseBytes(frames);
    const chunks: Uint8Array[] = [];
    if (chunkSize > 0) {
        for (let i = 0; i < bytes.length; i += chunkSize) chunks.push(bytes.subarray(i, i + chunkSize));
    } else {
        chunks.push(bytes);
    }
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
        },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

export function mockFetch(response: Response): typeof fetch {
    return (async () => response) as unknown as typeof fetch;
}

export const identityHeaders = {
    Authorization: "Cloud-IDE-JWT test-jwt",
    "X-Uid": "u1",
    "X-Device-Id": "d1",
    "X-Machine-Id": "m1",
};
