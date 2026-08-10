export type Component = {
  render(width: number): string[];
  invalidate(): void;
};

export class Text {
  private text: string;

  constructor(text = "", ..._args: unknown[]) {
    this.text = text;
  }

  setText(text: string): void {
    this.text = text;
  }

  render(_width: number): string[] {
    return this.text.split("\n");
  }

  invalidate(): void {}
}

export const Key = {
  enter: "enter",
  escape: "escape",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  ctrl(value: string): string {
    return `ctrl+${value}`;
  }
};

export function matchesKey(data: string, key: string): boolean {
  return data === key || (key === Key.enter && data === "\r") || (key === Key.escape && data === "\u001b");
}

export function visibleWidth(text: string): number {
  return [...text].length;
}

export function truncateToWidth(text: string, width: number, ellipsis = "..."): string {
  if (visibleWidth(text) <= width) return text;
  if (width <= visibleWidth(ellipsis)) return [...ellipsis].slice(0, width).join("");
  return `${[...text].slice(0, width - visibleWidth(ellipsis)).join("")}${ellipsis}`;
}

export function wrapTextWithAnsi(text: string, width: number): string[] {
  if (width <= 0) return [""];
  const lines: string[] = [];
  for (const logicalLine of text.split("\n")) {
    if (!logicalLine) {
      lines.push("");
      continue;
    }
    for (let offset = 0; offset < logicalLine.length; offset += width) {
      lines.push(logicalLine.slice(offset, offset + width));
    }
  }
  return lines;
}
