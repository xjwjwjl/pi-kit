// 原生 Provider 组装：Pi 负责 OAuth 刷新、CredentialStore 写入与内建 /logout。
// 扩展只定义 TRAE 特有的 credential 扩展字段与协议行为。
import { createProvider } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai";
import { loginTrae, refreshTrae, toTraeAuth } from "./auth/oauth.ts";
import { isTraeCredential } from "./auth/credential.ts";
import { streamTrae } from "./stream.ts";
import { TRAE_MODELS } from "./model-catalog.ts";
import type { TraeApi } from "./model-catalog.ts";

export const AGENT_HOST = "https://trae-api-cn.mchost.guru";

export function createTraeProvider(): Provider<TraeApi> {
    return createProvider({
        id: "trae",
        name: "TRAE CN",
        baseUrl: AGENT_HOST,
        auth: {
            oauth: {
                name: "TRAE 账号登录",
                login: loginTrae,
                refresh: refreshTrae,
                toAuth: toTraeAuth,
            },
        },
        models: TRAE_MODELS,
        // 旧 credential（缺设备字段）与未登录时都视为模型不可用，避免“看似可选、首请求才失败”
        filterModels: (models, credential) => (isTraeCredential(credential) ? models : []),
        api: { stream: streamTrae, streamSimple: streamTrae },
    });
}
