export type ExtensionAPI = {
  registerTool(definition: unknown): void;
  registerCommand(name: string, definition: unknown): void;
  on(event: string, handler: unknown): void;
};
