// streamSimple：领域事件 -> Pi AssistantMessageEventStream 的显式状态机。
// 保证：任何异常/abort/EOF-缺终态都以标准 Pi error 事件收尾，绝不悬挂或伪造成功。
import type {
    Api,
    AssistantMessage,
    AssistantMessageEventStream,
    Context,
    Model,
    SimpleStreamOptions,
    StopReason,
    ToolCall,
} from "@earendil-works/pi-ai";
import { calculateCost, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { TraeClient } from "./client/trae-client.ts";
import {
    TraeAuthError,
    TraeProtocolError,
    TraeStreamIncompleteError,
    TraeStreamTimeoutError,
    abortError,
    sanitizeErrorMessage,
} from "./client/errors.ts";
import { assertAuthFields, finalRequestHeaders } from "./client/headers.ts";
import { parseSse } from "./protocol/sse.ts";
import { validateSseEvent } from "./protocol/events.ts";
import type { TraeEvent, TraeToolCallDelta } from "./protocol/events.ts";
import { buildTraeChatRequest } from "./protocol/request.ts";

export const AGENT_HOST = "https://trae-api-cn.mchost.guru";
export const EP_CHAT = "/api/agent/v3/llm_utils_chat";

/** 连接建连超时（集中配置）。 */
const CONNECT_TIMEOUT_MS = 30_000;
/** 收到 response 后的空闲超时：每收到 SSE 字节重置；默认 5 分钟无数据视为中断。 */
const IDLE_TIMEOUT_MS = 300_000;

export function streamTrae(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    const output = createInitialAssistantMessage(model);
    const client = new TraeClient({ fetchFn: options?.fetch ?? globalThis.fetch });

    const userSignal = options?.signal;
    const fetchController = new AbortController();
    const onUserAbort = () => fetchController.abort(userSignal?.reason);
    userSignal?.addEventListener("abort", onUserAbort, { once: true });

    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let totalTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    void (async () => {
        try {
            stream.push({ type: "start", partial: output });

            // 认证在 try 内：任何失败都走 error 事件
            const apiKey = options?.apiKey;
            if (!apiKey) throw new TraeAuthError("TRAE 未登录：请先运行 /login trae");

            const headers = finalRequestHeaders("chat", options?.headers);
            assertAuthFields("chat", headers);

            connectTimer = setTimeout(
                () => fetchController.abort(new TraeStreamTimeoutError("TRAE 连接超时")),
                CONNECT_TIMEOUT_MS,
            );
            if (options?.timeoutMs !== undefined && options.timeoutMs > 0) {
                totalTimer = setTimeout(
                    () => fetchController.abort(new TraeStreamTimeoutError("TRAE 请求超时")),
                    options.timeoutMs,
                );
            }

            const response = await client.requestStream({
                url: AGENT_HOST + EP_CHAT,
                body: buildTraeChatRequest(model, context, options),
                headers,
                signal: fetchController.signal,
                onResponse: options?.onResponse ? (r) => options.onResponse?.(r, model) : undefined,
            });
            if (connectTimer) clearTimeout(connectTimer);
            connectTimer = undefined;
            if (!response.body) throw new TraeProtocolError("TRAE 无响应流");

            // 所有超时都通过 fetchController 中止：undici 会把 abort 传播到挂起的 body read。
            const resetIdle = () => {
                if (idleTimer) clearTimeout(idleTimer);
                idleTimer = setTimeout(
                    () => fetchController.abort(new TraeStreamTimeoutError("TRAE 流空闲超时")),
                    IDLE_TIMEOUT_MS,
                );
                idleTimer.unref?.();
            };
            resetIdle();
            const reader = response.body.getReader();
            // 防御：即使 transport 未把 fetch abort 传播到 body read，也能让挂起的 read 及时结束
            const guarded = guardReaderWithSignal(reader, fetchController.signal);

            const session = new StreamSession(stream, output, model);
            try {
                for await (const frame of parseSse(guarded, resetIdle)) {
                    session.accept(validateSseEvent(frame));
                }
            } finally {
                // 底层 read 可能仍挂起：cancel 会让其结束，随后释放锁
                await guarded.cancel().catch(() => {});
                try {
                    guarded.releaseLock();
                } catch {
                    /* ignore */
                }
            }
            session.finish();

            stream.push({
                type: "done",
                reason: output.stopReason as Extract<StopReason, "stop" | "length" | "toolUse">,
                message: output,
            });
        } catch (error) {
            const aborted = userSignal?.aborted ?? false;
            output.stopReason = aborted ? "aborted" : "error";
            output.errorMessage = describeStreamError(error, aborted);
            // 失败时移除占位的未完成工具块：不把 arguments:{} 的调用交给重试回放。
            output.content = output.content.filter((block) => block.type !== "toolCall");
            stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: output });
        } finally {
            if (connectTimer) clearTimeout(connectTimer);
            if (totalTimer) clearTimeout(totalTimer);
            if (idleTimer) clearTimeout(idleTimer);
            fetchController.abort();
            userSignal?.removeEventListener("abort", onUserAbort);
        }
        stream.end();
    })();

    return stream;
}

function describeStreamError(error: unknown, aborted: boolean): string {
    if (aborted) return "请求已取消";
    if (error instanceof TraeStreamTimeoutError) return "TRAE 请求超时";
    if (error instanceof Error) return sanitizeErrorMessage(error.message);
    return sanitizeErrorMessage(String(error));
}

function createInitialAssistantMessage(model: Model<Api>): AssistantMessage {
    return {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "pending",
        timestamp: Date.now(),
    };
}

/** 把外部 signal 的 abort 反映到 reader.read()：即使 transport 不传播 abort，挂起的 read 也会及时 reject。 */
function guardReaderWithSignal(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal: AbortSignal,
): ReadableStreamDefaultReader<Uint8Array> {
    const read = () => {
        if (signal.aborted) return Promise.reject(abortError(signal));
        return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
            const onAbort = () => {
                cleanup();
                reject(abortError(signal));
            };
            const cleanup = () => signal.removeEventListener("abort", onAbort);
            signal.addEventListener("abort", onAbort, { once: true });
            reader.read().then(
                (result) => {
                    cleanup();
                    resolve(result);
                },
                (error) => {
                    cleanup();
                    reject(error);
                },
            );
        });
    };
    return {
        read,
        cancel: reader.cancel.bind(reader),
        releaseLock: reader.releaseLock.bind(reader),
        get closed() {
            return reader.closed;
        },
    };
}

// ---------- Stream session 状态机 ----------

interface ToolAccumulator {
    index: number;
    id?: string;
    name?: string;
    /** 每个输出事件里的 arguments 帧。正常 TRAE 是增量分片，异常 DSML 泄漏路径可能返回累计快照。 */
    argumentFrames: string[];
    contentIndex: number;
}

class StreamSession {
    private readonly stream: AssistantMessageEventStream;
    private readonly output: AssistantMessage;
    private readonly model: Model<Api>;
    private doneReceived = false;
    private textIndex = -1;
    private thinkingIndex = -1;
    private toolCalls = new Map<number, ToolAccumulator>();
    private finishReason = "";

    constructor(stream: AssistantMessageEventStream, output: AssistantMessage, model: Model<Api>) {
        this.stream = stream;
        this.output = output;
        this.model = model;
    }

    accept(event: TraeEvent): void {
        switch (event.type) {
            case "output":
                if (event.reasoningContent) this.pushThinking(event.reasoningContent);
                if (event.response) this.pushText(event.response);
                if (event.toolCalls) {
                    for (const delta of event.toolCalls) this.pushToolDelta(delta);
                }
                break;
            case "usage":
                this.applyUsage(event);
                break;
            case "done":
                this.doneReceived = true;
                this.finishReason = event.finishReason;
                break;
            case "error":
                throw new TraeProtocolError(sanitizeErrorMessage(event.message, 300));
            case "ignored":
                break;
        }
    }

    /** 只有收到合法 done 才允许正常结束；否则抛 TraeStreamIncompleteError。 */
    finish(): void {
        if (!this.doneReceived) {
            throw new TraeStreamIncompleteError("TRAE 流在收到完成事件前中断");
        }
        this.closeBlocks();
        const hasToolCalls = this.finalizeToolCalls();
        this.output.stopReason = hasToolCalls ? "toolUse" : mapFinishReason(this.finishReason);
    }

    private closeBlocks(): void {
        if (this.thinkingIndex >= 0) {
            const block = this.output.content[this.thinkingIndex];
            if (block.type === "thinking") {
                this.stream.push({
                    type: "thinking_end",
                    contentIndex: this.thinkingIndex,
                    content: block.thinking,
                    partial: this.output,
                });
            }
        }
        if (this.textIndex >= 0) {
            const block = this.output.content[this.textIndex];
            if (block.type === "text") {
                this.stream.push({
                    type: "text_end",
                    contentIndex: this.textIndex,
                    content: block.text,
                    partial: this.output,
                });
            }
        }
    }

    private pushThinking(delta: string): void {
        if (this.thinkingIndex < 0) {
            this.output.content.push({ type: "thinking", thinking: "" });
            this.thinkingIndex = this.output.content.length - 1;
            this.stream.push({ type: "thinking_start", contentIndex: this.thinkingIndex, partial: this.output });
        }
        const block = this.output.content[this.thinkingIndex];
        if (block.type !== "thinking") throw new TraeProtocolError("思考块状态异常");
        block.thinking += delta;
        this.stream.push({ type: "thinking_delta", contentIndex: this.thinkingIndex, delta, partial: this.output });
    }

    private pushText(delta: string): void {
        // 过滤泄漏到正文的内部 DSML。正常流式正文不含这些标记，透传不受影响。
        const clean = stripLeakedDsml(delta);
        if (clean.length === 0) return;
        if (this.textIndex < 0) {
            this.output.content.push({ type: "text", text: "" });
            this.textIndex = this.output.content.length - 1;
            this.stream.push({ type: "text_start", contentIndex: this.textIndex, partial: this.output });
        }
        const block = this.output.content[this.textIndex];
        if (block.type !== "text") throw new TraeProtocolError("文本块状态异常");
        // 累计快照（下一帧是前一帧前缀重发）会放大正文：同一段已以前缀存在则跳过，避免反复追加。
        if (block.text.startsWith(clean)) return;
        block.text += clean;
        this.stream.push({ type: "text_delta", contentIndex: this.textIndex, delta: clean, partial: this.output });
    }

    private pushToolDelta(delta: TraeToolCallDelta): void {
        let acc = this.toolCalls.get(delta.index);
        if (!acc) {
            acc = { index: delta.index, argumentFrames: [], contentIndex: -1 };
            this.toolCalls.set(delta.index, acc);
        }
        if (delta.id !== undefined) acc.id = delta.id;
        if (delta.name !== undefined) acc.name = delta.name;
        if (delta.arguments !== undefined) acc.argumentFrames.push(delta.arguments);

        if (acc.contentIndex < 0) {
            // id/name 到齐才创建块；此前缓存的 arguments 补发为一段 delta
            if (acc.id !== undefined && acc.name !== undefined) {
                const toolCall: ToolCall = { type: "toolCall", id: acc.id, name: acc.name, arguments: {} };
                this.output.content.push(toolCall);
                acc.contentIndex = this.output.content.length - 1;
                const joined = acc.argumentFrames.join("");
                this.stream.push({ type: "toolcall_start", contentIndex: acc.contentIndex, partial: this.output });
                if (joined) {
                    this.stream.push({
                        type: "toolcall_delta",
                        contentIndex: acc.contentIndex,
                        delta: joined,
                        partial: this.output,
                    });
                }
            }
        } else if (delta.arguments !== undefined) {
            this.stream.push({
                type: "toolcall_delta",
                contentIndex: acc.contentIndex,
                delta: delta.arguments,
                partial: this.output,
            });
        }
    }

    private applyUsage(event: Extract<TraeEvent, { type: "usage" }>): void {
        const usage = this.output.usage;
        usage.input = event.promptTokens;
        usage.output = event.completionTokens;
        usage.cacheRead = event.cacheReadTokens;
        usage.cacheWrite = event.cacheWriteTokens;
        if (event.reasoningTokens !== undefined) usage.reasoning = event.reasoningTokens;
        usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
        usage.cost = calculateCost(this.model, usage);
    }

    /** 按 numeric index 排序结束；缺少 id/name 或 arguments 非法 JSON 都报协议错误，绝不回退空对象。 */
    private finalizeToolCalls(): boolean {
        const indices = [...this.toolCalls.keys()].sort((a, b) => a - b);
        for (const index of indices) {
            const acc = this.toolCalls.get(index)!;
            if (acc.id === undefined || acc.name === undefined) {
                throw new TraeProtocolError(`工具调用 ${index} 缺少 id 或 name`);
            }
            const parsed = finalizeToolArguments(acc.argumentFrames, index);
            if (acc.contentIndex < 0) {
                // id/name 直到 done 才到齐：补建块并补发 delta
                const toolCall: ToolCall = { type: "toolCall", id: acc.id, name: acc.name, arguments: parsed };
                this.output.content.push(toolCall);
                acc.contentIndex = this.output.content.length - 1;
                this.stream.push({ type: "toolcall_start", contentIndex: acc.contentIndex, partial: this.output });
                if (acc.argumentFrames.length > 0) {
                    this.stream.push({
                        type: "toolcall_delta",
                        contentIndex: acc.contentIndex,
                        delta: acc.argumentFrames.join(""),
                        partial: this.output,
                    });
                }
            }
            const block = this.output.content[acc.contentIndex];
            if (block.type !== "toolCall") throw new TraeProtocolError("工具调用块状态异常");
            block.arguments = parsed;
            this.stream.push({
                type: "toolcall_end",
                contentIndex: acc.contentIndex,
                toolCall: { ...block },
                partial: this.output,
            });
        }
        // 分片可能乱序到达：最终消息里的 toolCall 块按 numeric index 排序，保证稳定顺序
        this.reorderToolCallBlocksByIndex();
        return indices.length > 0;
    }

    private reorderToolCallBlocksByIndex(): void {
        const content = this.output.content;
        const toolCallPositions: number[] = [];
        content.forEach((block, i) => {
            if (block.type === "toolCall") toolCallPositions.push(i);
        });
        if (toolCallPositions.length < 2) return;
        const blocksByIndex = [...this.toolCalls.values()]
            .sort((a, b) => a.index - b.index)
            .map((acc) => content[acc.contentIndex]);
        toolCallPositions.forEach((position, rank) => {
            content[position] = blocksByIndex[rank];
        });
    }
}

function stripLeakedDsml(raw: string): string {
    const marker = raw.indexOf("<｜DSML｜tool_calls>");
    if (marker >= 0) return raw.slice(0, marker);
    return raw;
}

/**
 * 双候选重建 arguments。判定规则：
 * - 正常增量分片（最后一片自己无法解析）：join 唯一可用 → 返回 join。
 * - 泄露的累计快照（每帧是前一帧前缀的完整重发，join 会把多份 JSON 串起来而无法解析）：
 *   用最后一片快照；若其本身就是合法对象则采用，否则报协议错误。
 * - 两者都合法且相等：任意返回；两者都合法却不相等：以逻辑上的 join 为准，但保持可复现的报错路径。
 * 绝不自动补括号、截断字符串或回退 {}（可能导向危险的文件操作）。
 */
function finalizeToolArguments(frames: string[], index: number): Record<string, any> {
    if (frames.length === 0) {
        throw new TraeProtocolError(`工具调用 ${index} 缺少 arguments`);
    }
    if (frames.length === 1) {
        return parseToolArguments(frames[0], index);
    }
    const joined = frames.join("");
    const snapshot = frames[frames.length - 1];
    // 快照泄露路径：最后一帧是完整 JSON，且与 join 相异（join 是若干快照的串接，通常无法解析）。
    let snapshotObj: Record<string, any> | undefined;
    try {
        snapshotObj = parseToolArguments(snapshot, index);
    } catch {
        snapshotObj = undefined;
    }
    // 正常增量分片：join 可解析。当且仅当 join 失败时才考虑快照泄露。
    try {
        return parseToolArguments(joined, index);
    } catch {
        if (snapshotObj) return snapshotObj;
        throw new TraeProtocolError(`工具调用 ${index} 的 arguments 不是合法 JSON`);
    }
}

function parseToolArguments(raw: string, index: number): Record<string, any> {
    if (!raw) throw new TraeProtocolError(`工具调用 ${index} 缺少 arguments`);
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new TraeProtocolError(`工具调用 ${index} 的 arguments 不是合法 JSON`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new TraeProtocolError(`工具调用 ${index} 的 arguments 不是 JSON 对象`);
    }
    return parsed as Record<string, any>;
}

function mapFinishReason(reason: string): Extract<StopReason, "stop" | "length"> {
    switch (reason) {
        case "stop":
            return "stop";
        case "length":
        case "max_tokens":
            return "length";
        default:
            throw new TraeProtocolError(`未知的 finish_reason: ${sanitizeErrorMessage(reason, 50)}`);
    }
}
