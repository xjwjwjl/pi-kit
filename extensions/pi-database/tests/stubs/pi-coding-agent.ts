export type ExtensionAPI = {
  registerTool(definition: unknown): void;
  registerCommand(name: string, definition: unknown): void;
  on(event: string, handler: unknown): void;
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): void;
};

export function highlightCode(code: string, _language?: string): string[] {
  return code.split("\n");
}

export function keyHint(keybinding: string, description: string): string {
  return `[${keybinding}:${description}]`;
}
