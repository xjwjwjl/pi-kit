import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
  type TuiMouseEvent,
  visibleWidth,
} from "@earendil-works/pi-tui";

const SUMMARY_LINE = 1;
const RAIL_CHAR = "─";
const TITLE = "Workings";

export interface ActivityViewOptions {
  getTheme(): Theme;
  isCollapsed(): boolean;
  hasHint(): boolean;
  onToggle(): void;
  onCollapse(): void;
  releaseFocus(): void;
}

export class ActivityView implements Component {
  private readonly options: ActivityViewOptions;
  private cachedWidth = -1;
  private cachedLines: string[] | undefined;

  constructor(options: ActivityViewOptions) {
    this.options = options;
  }

  invalidate(): void {
    this.cachedWidth = -1;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    if (this.cachedLines && this.cachedWidth === safeWidth) return this.cachedLines;
    const theme = this.options.getTheme();
    const padding = safeWidth >= 3 ? 1 : 0;
    const contentWidth = Math.max(1, safeWidth - padding * 2);
    const summary = this.summaryLine(theme, contentWidth);
    const line = `${" ".repeat(padding)}${summary}${" ".repeat(Math.max(0, safeWidth - padding - visibleWidth(summary)))}`;
    this.cachedWidth = safeWidth;
    this.cachedLines = ["", theme.bg("toolPendingBg", line)];
    return this.cachedLines;
  }

  handleMouse(event: TuiMouseEvent): { handled: true; focus: true } | undefined {
    if (event.type !== "click" || event.button !== "left" || event.y !== SUMMARY_LINE) return undefined;
    this.options.onToggle();
    return { handled: true, focus: true };
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
      this.options.onToggle();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.options.onCollapse();
      this.options.releaseFocus();
    }
  }

  private summaryLine(theme: Theme, width: number): string {
    const collapsed = this.options.isCollapsed();
    const arrowText = collapsed ? "▹ " : "▿ ";
    const arrow = theme.fg("muted", arrowText);
    const hintText = collapsed && this.options.hasHint() ? " · click or press Enter to expand" : "";
    const fixedWidth = visibleWidth(arrowText) + visibleWidth(TITLE) + 2 + visibleWidth(hintText);
    const leftWidth = Math.max(0, Math.floor((width - fixedWidth - visibleWidth(arrowText)) / 2));
    const rightWidth = leftWidth > 0 ? leftWidth + visibleWidth(arrowText) : 0;
    const left = RAIL_CHAR.repeat(leftWidth);
    const right = RAIL_CHAR.repeat(rightWidth);
    const title = theme.bold(theme.fg("muted", TITLE));
    const rail = leftWidth > 0
      ? `${arrow}${theme.fg("dim", left)} ${title} ${theme.fg("dim", right)}`
      : `${arrow}${title}`;
    const hint = hintText ? theme.fg("dim", hintText) : "";
    return truncateToWidth(`${rail}${hint}`, width);
  }
}
