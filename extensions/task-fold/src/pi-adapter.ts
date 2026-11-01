import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  InteractiveMode,
  ToolExecutionComponent,
  VERSION,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Component } from "@earendil-works/pi-tui";
import { ActivityView } from "./activity-view.ts";
import type { HintState } from "./hint-state.ts";
import { isAssistantEntry, type FoldGroup, type VisibleActivity, visibleActivity } from "./task-model.ts";

type SessionManagerView = ExtensionContext["sessionManager"];

// These are private Pi 1.4.0 implementation details, deliberately isolated here.
const SUPPORTED_VERSION = "1.4.0";
const PATCH_OWNER = Symbol.for("pi-kit.task-fold.render-session-entries");

interface ChatContainer {
  children: Component[];
  removeChild(component: Component): void;
}

interface InteractiveModeInternals {
  chatContainer: ChatContainer;
  sessionManager: SessionManagerView;
  ui: {
    requestRender(): void;
    setFocus(component: Component | null): void;
  };
  editor: Component;
}

interface AssistantInternals extends Component {
  lastMessage?: AssistantMessage;
  updateContent: AssistantMessageComponent["updateContent"];
}

interface ToolInternals extends Component {
  toolCallId: string;
  render: ToolExecutionComponent["render"];
  handleMouse: ToolExecutionComponent["handleMouse"];
}

interface PatchedAssistant {
  kind: "assistant";
  component: AssistantInternals;
  group: GroupView;
  message: AssistantMessage;
  active: boolean;
  originalDescriptor: PropertyDescriptor | undefined;
  wrapper: AssistantInternals["updateContent"];
}

interface PatchedTool {
  kind: "tool";
  component: ToolInternals;
  group: GroupView;
  active: boolean;
  renderDescriptor: PropertyDescriptor | undefined;
  mouseDescriptor: PropertyDescriptor | undefined;
  renderWrapper: ToolInternals["render"];
  mouseWrapper: ToolInternals["handleMouse"];
}

type PatchedComponent = PatchedAssistant | PatchedTool;

interface GroupView {
  group: FoldGroup;
  activity: VisibleActivity;
  summary: ActivityView;
  visible: boolean;
  showHint: boolean;
}

type ModePrototype = Record<string, unknown>;
type Callable = (...args: never[]) => unknown;

function restoreOwnMethod(target: object, key: string, wrapper: unknown, descriptor: PropertyDescriptor | undefined): void {
  const current = Object.getOwnPropertyDescriptor(target, key);
  if (current?.value !== wrapper) return; // A later patch belongs to someone else.
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

/** Capture the exact interactive instance without changing the user's widget configuration. */
function captureMode(ctx: ExtensionContext): InteractiveModeInternals {
  const prototype = InteractiveMode.prototype as unknown as ModePrototype;
  const original = prototype.setExtensionWidget;
  if (typeof original !== "function") throw new Error("Pi's widget bridge is unavailable");
  const key = `task-fold-probe-${randomUUID()}`;
  let captured: unknown;
  const wrapper = function (this: unknown, ...args: unknown[]) {
    if (args[0] === key) captured = this;
    return Reflect.apply(original, this, args);
  };
  prototype.setExtensionWidget = wrapper;
  try {
    // Removing a fresh, random key cannot remove another extension's widget.
    ctx.ui.setWidget(key, undefined);
  } finally {
    if (prototype.setExtensionWidget === wrapper) prototype.setExtensionWidget = original;
  }
  const mode = captured as InteractiveModeInternals | undefined;
  if (!mode || mode.sessionManager !== ctx.sessionManager || !Array.isArray(mode.chatContainer?.children) ||
      typeof mode.chatContainer.removeChild !== "function" || typeof mode.ui?.requestRender !== "function" ||
      typeof mode.ui.setFocus !== "function" || !mode.editor) {
    throw new Error("Pi's interactive transcript layout is incompatible");
  }
  return mode;
}

export class TaskFoldAdapter {
  private readonly ctx: ExtensionContext;
  private readonly onError: (error: unknown) => void;
  private readonly hintState: HintState;
  private readonly mode: InteractiveModeInternals;
  private readonly manager: SessionManagerView;
  private readonly views: GroupView[] = [];
  private readonly groupKeys = new Set<string>();
  private readonly patched = new Map<Component, PatchedComponent>();
  private active = true;
  private readonly originalRenderEntries: Callable;
  private readonly renderEntriesWrapper: Callable;

  constructor(ctx: ExtensionContext, onError: (error: unknown) => void, hintState: HintState) {
    this.ctx = ctx;
    this.onError = onError;
    this.hintState = hintState;
    if (VERSION !== SUPPORTED_VERSION) {
      throw new Error(`requires Pi ${SUPPORTED_VERSION}; current version is ${VERSION}`);
    }
    this.manager = ctx.sessionManager;
    this.mode = captureMode(ctx);
    const prototype = InteractiveMode.prototype as unknown as ModePrototype;
    const original = prototype.renderSessionEntries;
    if (typeof original !== "function") throw new Error("Pi's session renderer is unavailable");
    if ((original as unknown as Record<symbol, unknown>)[PATCH_OWNER]) {
      throw new Error("another task-fold instance is already active");
    }
    this.originalRenderEntries = original as Callable;
    const adapter = this;
    const wrapper = function (this: unknown, ...args: unknown[]) {
      const result = Reflect.apply(original, this, args);
      if (this === adapter.mode && adapter.active) {
        try {
          adapter.refresh();
        } catch (error) {
          adapter.onError(error);
        }
      }
      return result;
    };
    Object.defineProperty(wrapper, PATCH_OWNER, { value: true });
    this.renderEntriesWrapper = wrapper as Callable;
    prototype.renderSessionEntries = wrapper;
  }

  add(group: FoldGroup, requireAssociation = true): void {
    if (!this.active) return;
    const view = this.createView(group);
    if (!view) return;
    this.refresh();
    if (requireAssociation && view.activity.items.length > 0 && !view.visible) {
      throw new Error("could not associate completed messages with Pi's transcript components");
    }
  }

  /** Batch-add reconstructed history, de-duplicated by assistant entries, then refresh once. */
  restore(groups: readonly FoldGroup[]): void {
    if (!this.active) return;
    for (const group of groups) this.createView(group);
    this.refresh();
  }

  private createView(group: FoldGroup): GroupView | undefined {
    const key = [...group.assistantIds].join("|");
    if (this.groupKeys.has(key)) return undefined;
    this.groupKeys.add(key);
    const view = {} as GroupView;
    view.group = group;
    view.activity = { counts: { tools: 0, failed: 0 }, items: [] };
    view.visible = false;
    view.showHint = false;
    view.summary = new ActivityView({
      getTheme: () => this.ctx.ui.theme,
      isCollapsed: () => view.group.collapsed,
      hasHint: () => view.showHint,
      onToggle: () => this.toggle(view),
      onCollapse: () => this.collapse(view),
      releaseFocus: () => this.releaseFocus(),
    });
    this.views.push(view);
    return view;
  }

  /** Toggle the most recent visible batch, or all visible batches. */
  change(action: "toggle" | "show" | "hide"): number {
    const visible = this.views.filter((view) => view.visible);
    if (action === "toggle") {
      const latest = visible.at(-1);
      if (!latest) return 0;
      const expanding = latest.group.collapsed;
      latest.group.collapsed = !latest.group.collapsed;
      if (expanding) this.hintState.markSeen();
      this.refresh();
      return 1;
    }
    let expanding = false;
    for (const view of visible) {
      if (view.group.collapsed && action === "show") expanding = true;
      view.group.collapsed = action === "hide";
    }
    if (expanding) this.hintState.markSeen();
    if (visible.length) this.refresh();
    return visible.length;
  }

  private toggle(view: GroupView): void {
    if (!this.active || !view.visible) return;
    const expanding = view.group.collapsed;
    view.group.collapsed = !view.group.collapsed;
    if (expanding) this.hintState.markSeen();
    try {
      this.refresh();
    } catch (error) {
      this.onError(error);
    }
  }

  private collapse(view: GroupView): void {
    if (!this.active || !view.visible || view.group.collapsed) return;
    view.group.collapsed = true;
    try {
      this.refresh();
    } catch (error) {
      this.onError(error);
    }
  }

  private releaseFocus(): void {
    this.mode.ui.setFocus(this.mode.editor);
  }

  private patchAssistant(component: AssistantInternals, group: GroupView, message: AssistantMessage): PatchedAssistant {
    const previous = component.updateContent;
    const record = {} as PatchedAssistant;
    Object.assign(record, {
      kind: "assistant", component, group, message, active: true,
      originalDescriptor: Object.getOwnPropertyDescriptor(component, "updateContent"),
    });
    const wrapper: AssistantInternals["updateContent"] = function (this: AssistantInternals, raw, isStreaming) {
      if (!record.active || !record.group.group.collapsed) return previous.call(this, raw, isStreaming);
      // Keep collapsed turns quiet; expanding restores Pi's native thinking rendering in place.
      const view = { ...raw, content: raw.content.filter((block) => block.type !== "thinking") };
      try {
        return previous.call(this, view, isStreaming);
      } finally {
        (this as AssistantInternals).lastMessage = raw;
      }
    };
    record.wrapper = wrapper;
    Object.defineProperty(component, "updateContent", { value: wrapper, writable: true, configurable: true });
    wrapper.call(component, message, false);
    return record;
  }

  private patchTool(component: ToolInternals, group: GroupView): PatchedTool {
    const previousRender = component.render;
    const previousMouse = component.handleMouse;
    const record = {} as PatchedTool;
    Object.assign(record, {
      kind: "tool", component, group, active: true,
      renderDescriptor: Object.getOwnPropertyDescriptor(component, "render"),
      mouseDescriptor: Object.getOwnPropertyDescriptor(component, "handleMouse"),
    });
    const renderWrapper: ToolInternals["render"] = function (this: ToolInternals, width) {
      return record.active && record.group.group.collapsed ? [] : previousRender.call(this, width);
    };
    const mouseWrapper: ToolInternals["handleMouse"] = function (this: ToolInternals, event) {
      return record.active && record.group.group.collapsed ? undefined : previousMouse.call(this, event);
    };
    record.renderWrapper = renderWrapper;
    record.mouseWrapper = mouseWrapper;
    Object.defineProperty(component, "render", { value: renderWrapper, writable: true, configurable: true });
    Object.defineProperty(component, "handleMouse", { value: mouseWrapper, writable: true, configurable: true });
    return record;
  }

  private unpatch(record: PatchedComponent): void {
    record.active = false; // Also makes our wrapper inert if another extension wrapped it later.
    if (record.kind === "assistant") {
      restoreOwnMethod(record.component, "updateContent", record.wrapper, record.originalDescriptor);
      record.component.updateContent(record.message);
    } else {
      restoreOwnMethod(record.component, "render", record.renderWrapper, record.renderDescriptor);
      restoreOwnMethod(record.component, "handleMouse", record.mouseWrapper, record.mouseDescriptor);
    }
    this.patched.delete(record.component);
  }

  /** Re-associate current components after Pi rebuilds the transcript, without moving native rows. */
  refresh(): void {
    if (!this.active || this.mode.sessionManager !== this.manager) return;
    const entries = this.manager.buildContextEntries();
    const messages = new Map<AssistantMessage, { view: GroupView; toolIds: ReadonlySet<string> }>();
    for (const view of this.views) {
      view.activity = visibleActivity(view.group, entries);
      view.visible = false;
      view.showHint = false;
      view.summary.invalidate();
      for (const entry of entries) {
        if (!isAssistantEntry(entry) || !view.group.assistantIds.has(entry.id)) continue;
        messages.set(entry.message, {
          view,
          toolIds: new Set(entry.message.content.flatMap((block) => block.type === "toolCall" ? [block.id] : [])),
        });
      }
    }

    for (const view of this.views) this.mode.chatContainer.removeChild(view.summary);

    const desired = new Map<Component, { view: GroupView; message?: AssistantMessage }>();
    const firstComponents = new Map<GroupView, Component>();
    let preceding: { view: GroupView; toolIds: ReadonlySet<string> } | undefined;
    for (const component of this.mode.chatContainer.children) {
      if (component instanceof AssistantMessageComponent) {
        const message = (component as unknown as AssistantInternals).lastMessage;
        preceding = message ? messages.get(message) : undefined;
        if (preceding && message) {
          desired.set(component, { view: preceding.view, message });
          if (!firstComponents.has(preceding.view)) firstComponents.set(preceding.view, component);
        }
      } else if (component instanceof ToolExecutionComponent && preceding?.toolIds.has((component as unknown as ToolInternals).toolCallId)) {
        desired.set(component, { view: preceding.view });
        if (!firstComponents.has(preceding.view)) firstComponents.set(preceding.view, component);
      }
    }

    for (const record of [...this.patched.values()]) {
      const target = desired.get(record.component);
      if (!target || target.view !== record.group || (record.kind === "assistant" && target.message !== record.message)) {
        this.unpatch(record);
      }
    }
    for (const [component, target] of desired) {
      let record = this.patched.get(component);
      if (!record) {
        record = target.message
          ? this.patchAssistant(component as AssistantInternals, target.view, target.message)
          : this.patchTool(component as ToolInternals, target.view);
        this.patched.set(component, record);
      }
      if (record.kind === "assistant") record.component.updateContent(record.message);
    }

    // Keep Pi's components flat: its native thinking/tool settings walk top-level children.
    let hintAssigned = false;
    for (const view of this.views) {
      const first = firstComponents.get(view);
      if (!first || view.activity.items.length === 0) continue;
      const index = this.mode.chatContainer.children.indexOf(first);
      if (index < 0) continue;
      view.visible = true;
      view.showHint = !this.hintState.seen && !hintAssigned && view.group.collapsed;
      if (view.showHint) hintAssigned = true;
      this.mode.chatContainer.children.splice(index, 0, view.summary);
    }
    this.mode.ui.requestRender();
  }

  dispose(): void {
    if (!this.active) return;
    this.active = false;
    const prototype = InteractiveMode.prototype as unknown as ModePrototype;
    if (prototype.renderSessionEntries === this.renderEntriesWrapper) {
      prototype.renderSessionEntries = this.originalRenderEntries;
    }
    for (const record of [...this.patched.values()]) {
      try { this.unpatch(record); } catch { this.patched.delete(record.component); }
    }
    for (const view of this.views) this.mode.chatContainer.removeChild(view.summary);
    this.views.length = 0;
    this.mode.ui.requestRender();
  }
}
