export type ExtensionAPI = {
	registerTool(definition: unknown): void;
	on(event: string, handler: unknown): void;
};
