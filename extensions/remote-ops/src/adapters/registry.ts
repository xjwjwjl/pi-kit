import type { RemoteExecProfile } from "../config/types.js";
import { HttpProxyAdapter } from "./http-proxy.js";
import type { AdapterFactory, RemoteAdapter } from "./types.js";

export class SystemAdapterFactory implements AdapterFactory {
	create(host: string, port: number, token: string): RemoteAdapter {
		return new HttpProxyAdapter(host, port, token);
	}
}
