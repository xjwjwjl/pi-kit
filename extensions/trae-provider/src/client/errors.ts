// TRAE 可辨别错误类型 + 错误文本脱敏。
// 规则：错误消息不得包含 JWT、refresh token、完整 callback URL 或完整服务端 body。

export class TraeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = new.target.name;
    }
}

/** 缺 credential 或认证字段不完整 */
export class TraeAuthError extends TraeError {}

/** HTTP 非 2xx，含脱敏后的 status 与有限 body 摘要 */
export class TraeHttpError extends TraeError {
    readonly status: number;
    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

/** 不符合已知 wire schema */
export class TraeProtocolError extends TraeError {}

/** EOF 前未收到 done 终态 */
export class TraeStreamIncompleteError extends TraeProtocolError {}

/** 当前模型无法表达的 Pi content（如图片输入） */
export class TraeUnsupportedInputError extends TraeError {}

/** 连接/请求/空闲超时 */
export class TraeStreamTimeoutError extends TraeError {}

/**
 * 对错误文本做纵深防御脱敏：截断 + 抹掉 JWT、refresh token、authorization 值。
 * 正常路径下错误消息由扩展自身构造（不含敏感值），此函数用于兜底服务端回显。
 */
export function sanitizeErrorMessage(message: string, maxLength = 500): string {
    let m = String(message).trim();
    m = m.replace(/(eyJ[A-Za-z0-9_-]{6,}\.){2}[A-Za-z0-9_-]{6,}/g, "<token>");
    m = m.replace(/(refresh[_-]?token[^\w]{0,4})[A-Za-z0-9._-]{8,}/gi, "$1<redacted>");
    m = m.replace(/(authorization[^\w]{0,4})[A-Za-z0-9._\- ]{8,}/gi, "$1<redacted>");
    if (m.length > maxLength) m = `${m.slice(0, maxLength)}…`;
    return m;
}

/** 从非 2xx HTTP 响应构造错误；401/403 给出重新登录的操作性提示。 */
export function httpErrorFromResponse(status: number, body: string): TraeHttpError {
    const detail = sanitizeErrorMessage(body, 200);
    if (status === 401 || status === 403) {
        return new TraeHttpError(status, `TRAE 登录状态失效（HTTP ${status}），请重新登录：${detail}`);
    }
    return new TraeHttpError(status, `TRAE HTTP ${status}: ${detail}`);
}

export function abortError(signal: AbortSignal): Error {
    const reason = signal.reason;
    if (reason instanceof Error) return reason;
    return new DOMException(reason === undefined ? "操作已取消" : String(reason), "AbortError");
}
