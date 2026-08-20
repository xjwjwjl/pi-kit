// SSE 解析：bytes -> SseFrame。
// 标准 SSE 语义：空行提交一条 record；多条 data: 行以 \n 拼接；event: 名在空行时重置；
// 支持 CRLF、任意 chunk 边界、UTF-8 跨 chunk；EOF 冲刷尾部未空行结尾的 record。
// 注释、id:、retry: 等未使用字段被忽略，但不会被当作 data。

export interface SseFrame {
    event: string;
    data: string;
}

export async function* parseSse(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    onChunk?: () => void,
): AsyncGenerator<SseFrame> {
    const decoder = new TextDecoder();
    let buffer = "";
    let event = "";
    let data = "";
    let hasData = false;
    const pending: SseFrame[] = [];

    const emitRecord = (): void => {
        if (!hasData) {
            event = ""; // 无 data 的 record 不产出，但重置 event
            return;
        }
        pending.push({ event: event || "message", data });
        event = "";
        data = "";
        hasData = false;
    };

    const processLine = (line: string): void => {
        if (line === "") {
            emitRecord();
            return;
        }
        if (line.startsWith(":")) return; // 注释
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") {
            event = value;
        } else if (field === "data") {
            data = data ? `${data}\n${value}` : value;
            hasData = true;
        }
        // id / retry 等字段忽略
    };

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        onChunk?.();
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, index).replace(/\r$/, "");
            buffer = buffer.slice(index + 1);
            processLine(line);
        }
        while (pending.length > 0) yield pending.shift()!;
    }
    buffer += decoder.decode(); // EOF flush 尾部字节
    if (buffer) processLine(buffer.replace(/\r$/, ""));
    emitRecord();
    while (pending.length > 0) yield pending.shift()!;
}
