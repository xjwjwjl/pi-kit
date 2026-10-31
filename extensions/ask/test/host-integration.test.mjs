import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { getEventListeners } from 'node:events';
import test from 'node:test';

const root = new URL('../node_modules/@earendil-works/', import.meta.url);
const imp = (suffix) => import(new URL(suffix, root).href);
const { loadExtensions } = await imp('pi-coding-agent/dist/core/extensions/loader.js');
const { InteractiveMode } = await imp('pi-coding-agent/dist/modes/interactive/interactive-mode.js');
const { ToolExecutionComponent } = await imp('pi-coding-agent/dist/modes/interactive/components/tool-execution.js');
const { createChatViewport } = await imp('pi-coding-agent/dist/modes/interactive/chat-viewport.js');
const { initTheme, theme } = await imp('pi-coding-agent/dist/modes/interactive/theme/theme.js');
const { KeybindingsManager } = await imp('pi-coding-agent/dist/core/keybindings.js');
const { TuiAltScreen, TuiMainScreen, Container, Text, Spacer, setKeybindings, stripTerminalSequences, sliceByColumn, visibleWidth, wrapTextWithAnsi, CURSOR_MARKER } = await imp('pi-tui/dist/index.js');
initTheme('dark', false);
const kb = new KeybindingsManager();
setKeybindings(kb);
const loaded = await loadExtensions(
  [fileURLToPath(new URL('../index.ts', import.meta.url))],
  fileURLToPath(new URL('../', import.meta.url)),
);
assert.deepEqual(loaded.errors, []);
const tool = loaded.extensions[0].tools.get('ask_user').definition;
const keys = {
  enter: '\r', down: '\x1b[B', up: '\x1b[A', left: '\x1b[D', right: '\x1b[C',
  tab: '\t', shiftTab: '\x1b[Z', esc: '\x1b', pageDown: '\x1b[6~', pageUp: '\x1b[5~',
  altUp: '\x1b[1;3A', altDown: '\x1b[1;3B', ctrlPageUp: '\x1b[5;5~', ctrlPageDown: '\x1b[6;5~',
  preview: '\x0f', note: '\x0e', skip: '\x13', clear: '\x15', home: '\x01',
  actions: '\x1b[17~', previousAction: '\x1b[17;2~',
};

async function start(questions, { columns = 40, rows = 12, below = 0, fullscreen = true, title } = {}) {
  const terminal = { columns, rows, write() {}, hideCursor() {}, showCursor() {} };
  const tui = fullscreen ? new TuiAltScreen(terminal, false) : new TuiMainScreen(terminal, false);
  if (fullscreen) tui.altScreenActive = true; // Run the real renderer without opening a terminal.
  tui.requestRender = () => {};
  tui.requestImmediateRender = () => {};
  const overlays = [];
  const showOverlay = tui.showOverlay.bind(tui);
  tui.showOverlay = (component, options) => {
    overlays.push({ component, options }); // Also catch invisible/briefly-created overlays.
    return showOverlay(component, options);
  };
  let cursorPosition;
  const extractCursorPosition = tui.extractCursorPosition.bind(tui);
  tui.extractCursorPosition = (lines, height) => {
    cursorPosition = extractCursorPosition(lines, height);
    return cursorPosition;
  };
  const editorContainer = new Container();
  let text = 'existing draft';
  const editor = { focused: false, getText: () => text, setText(value) { text = value; }, render: () => ['saved editor'], handleInput() {} };
  editorContainer.addChild(editor);
  const document = new Container();
  document.addChild(new Text(Array.from({ length: 60 }, (_, i) => `transcript${i.toString().padStart(2, '0')}`).join('\n'), 0, 0));
  const pendingMessages = new Container();
  const status = new Text('working', 0, 0);
  const widgetsAbove = new Spacer(1);
  const widgetsBelow = new Container();
  function setBelow(height) {
    widgetsBelow.clear();
    for (let i = 0; i < height; i++) widgetsBelow.addChild(new Text(`below${i.toString().padStart(2, '0')}`, 0, 0));
  }
  setBelow(below);
  const footer = new Text('cwd\nstats', 0, 0);
  const roots = [document, pendingMessages, status, widgetsAbove, editorContainer, widgetsBelow, footer];
  // Record lines actually returned to the host. Regular-mode coordinates come
  // from document flow, never from an overlay or a second component render.
  const rootLines = new Map();
  const rootRenderCounts = new Map();
  for (const child of roots) {
    const render = child.render.bind(child);
    child.render = (width) => {
      rootRenderCounts.set(child, (rootRenderCounts.get(child) ?? 0) + 1);
      const lines = render(width);
      rootLines.set(child, lines);
      return lines;
    };
    tui.addChild(child);
  }
  let viewport;
  if (fullscreen) {
    viewport = createChatViewport({ document, pendingMessages, status, widgetsAbove, editor: editorContainer, widgetsBelow, footer, scrollbar: 'hidden' });
    tui.setLayoutRoot(viewport.root);
  }
  const layoutRoot = tui.layoutRoot;
  const dispatch = tui.handleTerminalInput;
  const inputListeners = [...tui.inputListeners];
  tui.setFocus(editor);
  // Pi 1.4.0 keeps a dialog stack on the real InteractiveMode instance, so the fake
  // host borrows its prototype and only supplies the fields that path touches.
  const host = Object.assign(Object.create(InteractiveMode.prototype), {
    ui: tui,
    editor,
    editorContainer,
    keybindings: kb,
    extensionDialogs: [],
    programStatus: { setBlocked() {} },
    disposeActiveSelector() {},
  });
  let component;
  let inputCalls = 0;
  let rendered = [];
  let renderWidth;
  let settled = false;
  const customCalls = [];
  const controller = new AbortController();
  const params = { questions, ...(title !== undefined ? { title } : {}) };
  const original = structuredClone(params);
  const promise = tool.execute('host-regression', params, controller.signal, undefined, {
    mode: 'tui', hasUI: true, ui: { custom(...customArgs) {
      const [factory, options] = customArgs;
      customCalls.push(customArgs);
      return InteractiveMode.prototype.showExtensionCustom.call(host, (...args) => {
        component = factory(...args);
        const handleInput = component.handleInput.bind(component);
        component.handleInput = (data) => { inputCalls++; handleInput(data); };
        const render = component.render.bind(component);
        component.render = (width) => {
          renderWidth = width;
          rendered = render(width);
          return rendered;
        };
        return component;
      }, options);
    } },
  });
  promise.then(() => { settled = true; });
  function assertResultContract(result) {
    assert.deepEqual(params, original, 'the entire caller input must remain unchanged');
    assert.equal('description' in result.details, false, 'results must not retain a global description');
    assert.deepEqual(result.details.questions, original.questions.map((question, index) => ({
      id: question.id, label: question.label || `Q${index + 1}`, kind: question.kind, required: question.required !== false,
    })), 'result questions must contain exactly id, label, kind and required, never copied body/option metadata');
    const answeredIds = new Set(result.details.answers.map(({ id }) => id));
    assert.deepEqual(result.details.answers.map(({ id }) => id),
      original.questions.filter(({ id }) => answeredIds.has(id)).map(({ id }) => id),
      'answers must follow questionnaire order, never default-seed or user interaction insertion order');
    for (const answer of result.details.answers) {
      assert.equal('status' in answer, false, `${answer.kind} answers must not contain status`);
      assert.equal('index' in answer, false, `${answer.kind} answers must not contain index`);
    }
  }
  await Promise.resolve(); // Let showExtensionCustom mount/focus the component.
  function assertHost() {
    assert.equal(overlays.length, 0, 'no overlay may ever be created, even invisibly');
    assert.equal(tui.hasOverlay(), false);
    assert.equal(customCalls.length, 1);
    assert.equal(customCalls[0].length, 1, 'custom must receive only its factory, with no overlay options');
    assert.equal(tui.layoutRoot, layoutRoot, 'the extension must not replace the application layout');
    assert.deepEqual(tui.children, roots, 'the seven host roots must retain their identities and order');
    assert.equal(host.editorContainer, editorContainer);
    assert.equal(tui.handleTerminalInput, dispatch, 'the extension must not intercept global input');
    assert.deepEqual([...tui.inputListeners], inputListeners, 'local paging must not install global key hooks');
    assert.deepEqual(editorContainer.children, [settled ? editor : component]);
  }
  function rawScreen() {
    assertHost();
    tui.renderNow();
    return fullscreen ? tui.getScreenLines() : tui.previousLines.slice(tui.previousViewportTop, tui.previousViewportTop + terminal.rows);
  }
  function findBox(box, target) {
    if (box.component === target) return box;
    for (const child of box.children) {
      const found = findBox(child, target);
      if (found) return found;
    }
  }
  function region(target) {
    let x = 0, y, width = terminal.columns, height;
    if (fullscreen) {
      // Private layout inspection is deliberately confined to this test harness.
      const box = findBox(tui.currentLayout.root, target);
      assert.ok(box, 'the original editor dock must remain in the actual host layout');
      x = Math.max(box.rect.x, box.clip.x, 0);
      y = Math.max(box.rect.y, box.clip.y, 0);
      width = Math.max(0, Math.min(box.rect.x + box.rect.width, box.clip.x + box.clip.width, terminal.columns) - x);
      height = Math.max(0, Math.min(box.rect.y + box.rect.height, box.clip.y + box.clip.height, terminal.rows) - y);
    } else {
      y = -tui.previousViewportTop;
      for (const child of roots) {
        if (child === target) break;
        y += rootLines.get(child)?.length ?? 0;
      }
      height = rootLines.get(target)?.length ?? 0;
      const end = Math.min(terminal.rows, y + height);
      y = Math.max(0, y);
      height = Math.max(0, end - y);
    }
    return { row: y, col: x, width, height };
  }
  function panel() {
    const screen = rawScreen();
    const bounds = region(editorContainer);
    const raw = screen.slice(bounds.row, bounds.row + bounds.height)
      .map((line) => sliceByColumn(line, bounds.col, bounds.width));
    const frame = raw.map(stripTerminalSequences);
    Object.defineProperty(frame, 'raw', { value: raw });
    return frame;
  }
  return {
    tui, terminal, component, controller, promise, editor, editorContainer, overlays, fullscreen, assertResultContract,
    screen: () => rawScreen().map(stripTerminalSequences), panel, rawScreen, setBelow,
    bounds() { rawScreen(); return region(editorContainer); },
    region(target) { rawScreen(); return region(target); },
    widgetsBelow, footer, status, viewport,
    transcript(result, expanded = false) {
      assert.equal(settled, true, 'only finalized results belong in the transcript');
      const execution = new ToolExecutionComponent('ask_user', 'host-regression', params, {}, tool, tui,
        fileURLToPath(new URL('../', import.meta.url)));
      execution.setArgsComplete();
      execution.markExecutionStarted();
      execution.updateResult(result);
      execution.setExpanded(expanded);
      document.clear();
      document.addChild(execution);
      rawScreen();
      // Capture the real host document render, not a direct renderResult call.
      return rootLines.get(document).map(stripTerminalSequences);
    },
    send: (...data) => data.forEach((key) => { assertHost(); tui.handleTerminalInput(key); }),
    get inputCalls() { return inputCalls; },
    renderCounts: () => ({ document: rootRenderCounts.get(document) ?? 0, pending: rootRenderCounts.get(pendingMessages) ?? 0, status: rootRenderCounts.get(status) ?? 0, above: rootRenderCounts.get(widgetsAbove) ?? 0, below: rootRenderCounts.get(widgetsBelow) ?? 0, footer: rootRenderCounts.get(footer) ?? 0 }),
    get editorText() { return text; },
    get rendered() { return rendered; },
    get renderWidth() { return renderWidth; },
    get active() { assertHost(); return !settled; },
    get cursorVisible() {
      rawScreen();
      if (!cursorPosition) return false;
      const row = cursorPosition.row - (fullscreen ? 0 : tui.previousViewportTop);
      const bounds = region(editorContainer);
      return row >= bounds.row && row < bounds.row + bounds.height
        && cursorPosition.col >= bounds.col && cursorPosition.col < bounds.col + bounds.width
        && row >= 0 && row < terminal.rows && cursorPosition.col < terminal.columns;
    },
    assertRestored() {
      assertHost();
      assert.equal(settled, true);
      assert.equal(tui.getFocusedComponent(), editor);
      assert.equal(text, 'existing draft');
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    },
    async close() {
      controller.abort();
      const result = await promise;
      tui.stopped = true;
      tui.cancelRenderTimer();
      assert.deepEqual(params, original, 'cleanup must not mutate the caller input');
      return result;
    },
  };
}
const single = (extra = {}) => ({ id: 'q', prompt: 'Choose', kind: 'single', allowCustom: false, options: [
  { value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' },
], ...extra });

function screenshotQuestions() {
  return [{
    id: 'scope', label: 'Scope', kind: 'multi', allowCustom: true,
    prompt: 'SCREENSHOT_BODY_HEAD: Which parts of this change should be included?\nSelect the work that is actually needed.',
    description: 'Each option includes its own explanation.\nA custom answer is available after the four fixed choices.',
    options: [
      { value: 'review', label: 'Read-only review', description: 'Inspect the existing behavior before changing it.\nReport concrete findings and relevant locations.' },
      { value: 'change', label: 'Targeted change', description: 'Implement only the agreed behavior.\nPreserve unrelated work and existing interactions.' },
      { value: 'verify', label: 'Verification', description: 'Exercise both ordinary and fullscreen hosts.\nCheck navigation, editing, and resizing.' },
      { value: 'docs', label: 'Documentation', description: 'Describe the supported interaction clearly.\nSCREENSHOT_BODY_TAIL: Record limitations without implying approval.' },
    ],
  }, { id: 'short', label: 'Short', kind: 'text', prompt: 'Short answer?' }];
}

function assertFixedRuleFrame(frame, bounds, context = '') {
  const message = `${context}: actual ${bounds.width}x${bounds.height} editor frame\n${frame.join('\n')}`;
  assert.equal(frame.length, bounds.height, message);
  const ruleRows = frame.flatMap((line, index) => /^(?:─+|─ .+ ─+)$/.test(line) ? [index] : []);
  if (bounds.height >= 8) {
    assert.deepEqual(ruleRows, [0, frame.length - 1], `both rules must be pinned outside the body; ${message}`);
  } else {
    assert.ok(ruleRows.length === 0 || ruleRows.length === 2, `tiny space may omit rules only as a pair; ${message}`);
    if (ruleRows.length) assert.deepEqual(ruleRows, [0, frame.length - 1], message);
  }
  for (const index of ruleRows) {
    assert.equal(visibleWidth(frame[index]), bounds.width, `rules must span the actual host width; ${message}`);
    if (index !== 0 || /^─+$/.test(frame[index])) {
      assert.equal(frame[index], '─'.repeat(bounds.width), `the bottom rule must remain plain; ${message}`);
      // Host column slicing stops at the last cell, before the trailing FG reset.
      assert.ok(frame.raw[index].includes(theme.getFgAnsi('accent') + '─'.repeat(bounds.width)),
        `plain rules must retain the accent theme color; ${message}`);
    } else {
      const tail = frame[index].match(/─+$/)[0];
      assert.ok(sliceByColumn(frame.raw[index], 0, 1).includes(theme.getFgAnsi('accent') + '─'),
        `the actual leading cell must be accent; ${message}`);
      assert.ok(sliceByColumn(frame.raw[index], bounds.width - tail.length, tail.length)
        .includes(theme.getFgAnsi('accent') + tail), `the actual trailing cells must be accent; ${message}`);
    }
  }
}

function assertTitleRule(frame, bounds, expectedTitle) {
  assertFixedRuleFrame(frame, bounds, 'title-only upper rule');
  const match = frame[0]?.match(/^─ (.+) (─+)$/);
  assert.ok(match, `the title must share the first rule, with at least one trailing rule cell:\n${frame.join('\n')}`);
  const title = match[1];
  if (expectedTitle !== undefined) assert.equal(title, expectedTitle,
    'preserve only the supplied title, including any caller middle dot, without a subtitle or added question count');
  assert.equal(frame.raw.findIndex((line) => line.includes(theme.getBgAnsi('selectedBg'))), 1,
    'the independent tab row must immediately follow the title rule, never global context');
  const titleCells = sliceByColumn(frame.raw[0], 2, visibleWidth(title));
  assert.ok(titleCells.includes(theme.getFgAnsi('text')), 'the title must use the text theme color');
  // The SDK theme can suppress bold attributes when the test process is not a TTY.
  const boldPrefix = theme.bold('title').split('title')[0];
  assert.ok(titleCells.includes(boldPrefix), 'the title must retain the available theme bold styling');
  return title;
}

function assertBackgroundPlacement(frame, marker, prompt) {
  const tab = frame.raw.findIndex((line) => line.includes(theme.getBgAnsi('selectedBg')));
  assert.ok(tab >= 0, `the active tab must remain visible:\n${frame.join('\n')}`);
  const promptRow = prompt ? frame.findIndex((line) => line.includes(prompt)) : -1;
  if (promptRow >= 0) assert.ok(promptRow > tab, 'the prompt must remain in the question body');
  for (const [index, line] of frame.entries()) {
    const background = typeof marker === 'string' ? line.includes(marker) : marker.has(line.trim());
    if (!background) continue;
    assert.ok(index > tab, `question descriptions belong below the tab in the question body:\n${frame.join('\n')}`);
    if (promptRow >= 0) assert.ok(index > promptRow, 'question descriptions follow, never precede, the prompt');
    assert.ok(frame.raw[index].includes(theme.getFgAnsi('muted')), 'question descriptions must use ordinary muted body styling');
    if (typeof marker === 'string') assert.equal(frame.join('\n').split(marker).length - 1, 1,
      'question descriptions must not be duplicated in the same viewport');
  }
  return tab;
}

function assertTabGap(frame, height, prompt) {
  const tab = frame.raw.findIndex((line) => line.includes(theme.getBgAnsi('selectedBg')));
  const message = `tab-to-body spacing at actual height ${height}:\n${frame.join('\n')}`;
  if (height >= 8) {
    assert.ok(tab >= 0, `the tab must remain visible; ${message}`);
    assert.equal(frame[tab + 1], '', `reserve the blank immediately after the tab, not the prompt-to-choice gap; ${message}`);
    if (prompt !== undefined) assert.ok(frame[tab + 2]?.startsWith(` ${prompt}`),
      `exactly one blank must precede the start of the prompt; ${message}`);
  } else if (tab >= 0 && prompt !== undefined) {
    // A paged body may itself begin with its existing prompt-to-choice blank.
    // Use a known body line to distinguish that from a reserved header gap.
    assert.ok(frame[tab + 1]?.startsWith(` ${prompt}`), `tiny allocations must place known content directly after the tab; ${message}`);
  }
  return tab;
}

function spacingQuestion(kind, total, extra = {}) {
  return single({ kind, allowCustom: true, prompt: 'SPACING_PROMPT', options: Array.from({ length: total - 1 }, (_, index) => ({
    value: `item${index + 1}`, label: `Spacing choice ${index + 1}`,
  })), ...extra });
}

function focusedChoice(s) {
  const line = s.panel().find((line) => /^\s*> /.test(line)) || '';
  assert.doesNotMatch(line, /> \[(?:Skip|Submit|Next|Review|Details|Hide details|Add note|Edit note|预览|附加说明|跳过)\]/,
    'only actual choices may have the choice-focus marker');
  return line.slice(Math.max(0, line.indexOf('> ')));
}

function focusedAuxiliary(s) {
  for (const line of s.panel().raw) {
    for (const segment of line.split(theme.getBgAnsi('selectedBg')).slice(1)) {
      const text = stripTerminalSequences(segment.split('\x1b[49m')[0]).trim();
      if (/^\[(?:附加说明|说明)/.test(text) || text === '说明' || text === '注') return 'note';
      if (/^\[跳过/.test(text) || text === '跳过' || text === '跳') return 'skip';
    }
  }
  return undefined;
}

function hasAuxiliaryRow(lines) {
  return lines.some((line) => /\[(?:附加说明|说明)/.test(line) && line.includes('[跳过'));
}

function assertAuxiliaryVisible(s) {
  // Narrow tiers abbreviate the note label to [说明]; both controls must still show.
  const line = s.panel().find((row) => hasAuxiliaryRow([row]));
  assert.ok(line, `both independent controls must be visible, not just hidden shortcuts:\n${s.panel().join('\n')}`);
  assert.match(line, /Tab/, 'the focus path is discoverable on the same row');
}

function activeTabFromFrame(frame) {
  const background = theme.getBgAnsi('selectedBg');
  const line = frame.raw.find((line) => line.includes(background));
  return stripTerminalSequences(line?.split(background)[1]?.split('\x1b[49m')[0] || '').trim();
}

function activeTab(s) {
  return activeTabFromFrame(s.panel());
}

function tabLine(s) {
  const frame = s.panel();
  return frame.find((_, index) => frame.raw[index].includes(theme.getBgAnsi('selectedBg'))) || '';
}

function assertPreviewTab(s) {
  assert.equal(activeTab(s), '预览', 'the neutral final preview tab must be active');
}

function focusPreview(s) {
  for (let i = 0; i < 32; i++) {
    if (activeTab(s) === '预览') return;
    s.send(keys.right);
  }
  assert.fail(`Could not reach 预览 with Tab:\n${s.panel().join('\n')}`);
}

function assertQuietPreview(frames) {
  assert.doesNotMatch(frames.flat().join('\n'), /Ready to submit|Unresolved required|not approval|Answer or/i,
    'review UI must not repeat internal submission or model-safety guidance');
}

function assertPreviewAction(frame, ready, compact = false) {
  const action = frame.find((line) => /^\s*Enter /.test(line));
  assert.ok(action, `the primary preview action must remain visible in the actual host frame:\n${frame.join('\n')}`);
  assert.match(action, ready ? /^\s*Enter (?:提交回答|提交)(?:\s|$)/ : /^\s*Enter (?:继续回答|补答)(?:\s|$)/,
    'the primary Enter action must precede, not be truncated behind, the Alt+arrow scroll legend');
  if (!compact) assert.match(action, ready ? /^\s*Enter 提交回答(?:\s|$)/ : /^\s*Enter 继续回答(?:\s|$)/,
    'normal-width previews must show the full primary action, not the narrow fallback');
}

function pageFrames(s, direction, count = 32) {
  const frames = [s.panel()];
  for (let i = 0; i < count; i++) {
    s.send(direction);
    // Repeated prompt/detail lines can produce identical adjacent pages; still
    // dispatch the full bounded walk so later unique content remains reachable.
    frames.push(s.panel());
  }
  return frames;
}

function allPanelFrames(s) {
  return [...pageFrames(s, keys.altUp), ...pageFrames(s, keys.altDown)];
}

function bodyFrame(frame) {
  // Repeated header/help labels cannot stand in for wrapped body text.
  const tab = frame.raw.findIndex((line) => line.includes(theme.getBgAnsi('selectedBg')));
  const start = tab < 0 ? 0 : tab + 1;
  const end = frame.findIndex((line, index) => index >= start && (
    /^\s*(?:\[(?:附加说明|说明)|说明 跳过|注 跳|Tab 切换|Alt\+↑↓|↑↓ 选择|Enter 保存|Enter (?:继续回答|补答|提交回答|提交)|Ctrl\+N)/i.test(line)
  ));
  return frame.slice(start, end < 0 ? undefined : end).filter((line) => !/^─+$/.test(line));
}

function assertInline(s) {
  const { rows, columns } = s.terminal;
  const bounds = s.bounds();
  const budget = Math.min(14, Math.max(1, rows - 4));
  assert.equal(bounds.width, columns, 'inline input must use the full host width, including widths above 96');
  assert.equal(bounds.col, 0, 'inline input must align with the original editor, without outer margins');
  assert.ok(bounds.height > 0, `${columns}x${rows}: the feasible inline fixture must display its editor`);
  assert.ok(s.rendered.length <= budget, `${columns}x${rows}: natural requested height ${s.rendered.length} exceeds ${budget}`);
  assert.equal(s.renderWidth, columns, 'the real host must supply the full input width');
  assert.ok(s.rendered.every((line) => visibleWidth(line) <= columns));
  if (s.fullscreen) {
    assert.ok(s.rendered.length >= bounds.height);
    assert.ok(s.rendered.slice(bounds.height).every((line) => !stripTerminalSequences(line).trim()),
      'only an invisible blank tail may extend beyond the host allocation');
  } else {
    assert.equal(s.rendered.length, bounds.height, 'regular mode must fit visibly without opaque tail padding');
  }
  assert.doesNotMatch(s.panel().join('\n'), /(?:^|\n)[╭┌┏│┃]/, 'native inline separators must not become a boxed panel');
  for (const sibling of [s.widgetsBelow, s.footer]) {
    const region = s.region(sibling);
    if (region.height > 0) assert.ok(bounds.row + bounds.height <= region.row, 'inline input must not overlap below widgets or the footer');
  }
  assert.equal(s.tui.getFocusedComponent(), s.component);
  return bounds;
}

function focusChoice(s, label) {
  // Walk actual host dispatch, without reading component-private indices.
  for (const direction of [keys.up, keys.down]) {
    for (let i = 0; i < 32; i++) {
      if (focusedChoice(s).includes(label)) return;
      s.send(direction);
    }
  }
  assert.fail(`Could not focus choice ${JSON.stringify(label)}:\n${s.screen().join('\n')}`);
}

function assertQuestion(s, prompt) {
  assert.equal(s.active, true, 'saving must not complete the inline flow');
  assert.ok(activeTab(s) && activeTab(s) !== '预览', 'saving must stay on the question tab');
  assert.ok(allPanelFrames(s).some((frame) => frame.some((line) => line.includes(prompt))),
    'the current prompt must remain reachable in the local viewport');
}

function questionIdsInLines(lines, questions, transcript = false) {
  return lines.flatMap((line) => {
    const text = line.trimStart();
    if (transcript && !text.startsWith('✓ ')) return [];
    const body = transcript ? text.slice(2) : text;
    const question = questions.find(({ label }) => body.startsWith(`${label}:`) || body.startsWith(`${label}：`));
    return question ? [question.id] : [];
  });
}

function previewQuestionOrder(s, questions) {
  focusPreview(s);
  pageFrames(s, keys.altUp); // Begin at the first body page, not wherever the caller left it.
  const frames = pageFrames(s, keys.altDown);
  const ids = [...new Set(questionIdsInLines(frames.flatMap(bodyFrame), questions))];
  assert.deepEqual(ids, questions.map(({ id }) => id), 'actual paged preview must retain questionnaire order');
  assertQuietPreview(frames);
  return { ids, frames };
}

function assertAnswerPipeline(s, result, previewIds, expectedIds) {
  s.assertResultContract(result);
  assert.deepEqual(result.details.answers.map(({ id }) => id), expectedIds);
  assert.deepEqual(previewIds.filter((id) => expectedIds.includes(id)), expectedIds);
  const model = result.content.map((part) => part.text || '').join('\n');
  const modelIds = [...model.matchAll(/(?:^User responses: |\. )([a-z][a-z0-9-]*)=\{/g)]
    .map((match) => match[1]).filter((id) => result.details.questions.some((question) => question.id === id));
  assert.deepEqual(modelIds, expectedIds, 'model answer segments must use the same order as the preview and details');
  assert.match(model, /not approval/);
  for (const expanded of [false, true]) {
    const transcript = s.transcript(result, expanded);
    assert.deepEqual(questionIdsInLines(transcript, result.details.questions, true), expectedIds,
      `actual ${expanded ? 'expanded' : 'collapsed'} SDK transcript must preserve answer order without a fallback`);
    assert.doesNotMatch(transcript.join('\n'), /\(default\)|\(typed\)|Unresolved required|not approval/);
  }
}

async function complete(s) {
  focusPreview(s);
  assertPreviewTab(s);
  s.send(keys.enter);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.active, false, 'only explicit Enter on an eligible preview tab must complete');
  const result = await s.promise;
  s.assertRestored();
  s.assertResultContract(result);
  return result;
}


for (const fullscreen of [false, true]) {
  const mode = fullscreen ? 'fullscreen' : 'regular';


  test(`actual ${mode} title-only headers keep Unicode multiline question descriptions below their own prompts across themes and resizes`, async (t) => {
    for (const themeName of ['dark', 'light']) await t.test(themeName, async () => {
      initTheme(themeName, false);
      const title = '范围👩‍💻e\u0301 · 原文';
      const markers = ['QUESTION_CONTEXT_HEAD 范围👩‍💻e\u0301', 'QUESTION_CONTEXT_TAIL 下一行'];
      const description = [...(themeName === 'dark' ? [markers[0]] : markers), 'FIRST_QUESTION_DETAIL'].join('\n');
      const contextLines = description.split('\n');
      const questions = [single({ label: 'Scope', prompt: 'CURRENT_PROMPT', defaultValue: 'b', description, options: [
        { value: 'a', label: 'Alpha', description: 'ALPHA_DETAIL' },
        { value: 'b', label: 'Beta', description: 'BETA_DETAIL' },
      ] }), single({ id: 'next', label: 'Next', prompt: 'NEXT_PROMPT', description: 'NEXT_QUESTION_DETAIL', defaultValue: 'a' })];
      const original = structuredClone(questions);
      const s = await start(questions, { fullscreen, columns: 80, rows: 24, title });
      try {
        for (const [columns, rows] of [[80, 24], [40, 24], [40, 12], [80, 24]]) {
          s.terminal.columns = columns;
          s.terminal.rows = rows;
          for (const tab of ['first', 'next', 'preview']) {
            const bounds = assertInline(s);
            const frames = allPanelFrames(s);
            for (const frame of frames) {
              assertTitleRule(frame, bounds, title);
              assertTabGap(frame, bounds.height);
              assert.equal(frame.filter((line) => line.includes(title)).length, 1);
              if (tab === 'first') assertBackgroundPlacement(frame, new Set(contextLines), 'CURRENT_PROMPT');
              else for (const marker of markers) assert.ok(!frame.join('\n').includes(marker),
                'question descriptions must not leak into other questions or the final preview');
              if (tab === 'preview') assertPreviewAction(frame, true, columns < 80);
            }
            if (tab === 'first') {
              for (const line of [...contextLines, 'ALPHA_DETAIL', 'BETA_DETAIL']) {
                assert.ok(frames.some((frame) => frame.some((visible) => visible.trim() === line)), `${line} must remain fully reachable`);
                assert.ok(frames.every((frame) => frame.filter((visible) => visible.trim() === line).length <= 1), `${line} must appear only once`);
              }
              if (rows === 24) {
                const first = pageFrames(s, keys.altUp).at(-1);
                const firstTab = assertTabGap(first, bounds.height, 'CURRENT_PROMPT');
                assert.deepEqual(first.slice(firstTab + 2, firstTab + 3 + contextLines.length),
                  [' CURRENT_PROMPT', ...contextLines.map((line) => ` ${line}`)],
                  'the question description itself must follow the prompt without added header context');
              }
              assertAuxiliaryVisible(s);
            } else if (tab === 'next') {
              const first = pageFrames(s, keys.altUp).at(-1);
              const nextTab = assertTabGap(first, bounds.height, 'NEXT_PROMPT');
              assert.equal(first[nextTab + 3], ' NEXT_QUESTION_DETAIL', 'later question descriptions keep their own position');
            } else assertQuietPreview(frames);
            assert.equal(s.active, true, 'resize, paging and visiting preview must not submit');
            s.send(keys.right);
          }
        }
        const result = await complete(s);
        assert.equal(result.details.title, title);
        assert.deepEqual(result.details.questions, [
          { id: 'q', label: 'Scope', kind: 'single', required: true },
          { id: 'next', label: 'Next', kind: 'single', required: true },
        ], 'display metadata must not be copied into the four-field question projection');
        assert.deepEqual(questions, original, 'rendering must not mutate caller questions');
        assert.deepEqual(result.details.answers.map((answer) => answer.value), ['b', 'a']);
        assert.deepEqual(result.details.notes, {});
        assert.deepEqual(result.details.skippedIds, []);
      } finally {
        try { await s.close(); } finally { initTheme('dark', false); }
      }
    });
  });

  test(`actual ${mode} answer pipeline follows question order after late answers, seeded defaults and reanswers`, async () => {
    const questions = [single({ id: 'first', label: 'First', prompt: 'FIRST_ORDER_PROMPT', description: 'Original context', options: [
      { value: 'a', label: 'Alpha', description: 'Original option detail', preview: 'ORDER_PREVIEW\n'.repeat(40) },
      { value: 'b', label: 'Beta' },
    ] }), single({ id: 'middle', label: 'Middle', kind: 'multi', allowCustom: true, prompt: 'MIDDLE_ORDER_PROMPT' }),
    single({ id: 'seeded', label: 'Seeded', defaultValue: 'b', prompt: 'SEEDED_ORDER_PROMPT' })];
    const original = structuredClone(questions);
    const s = await start(questions, { fullscreen, columns: 160, rows: 24 });
    try {
      assertTitleRule(s.panel(), s.bounds(), '请确认');
      assert.match(s.panel().join('\n'), /↑↓ 选择 · Enter 确认并下一题 · ←→ 切题 · Ctrl\+O 预览 · Esc 取消/);
      s.send(keys.actions);
      assert.match(s.panel().join('\n'), /Tab 切换 · Enter 确认 · ↑↓ 返回答案 · ←→ 切题 · Esc 取消/);
      s.send(keys.up, keys.preview);
      const previewFrames = allPanelFrames(s);
      assert.match(previewFrames.flat().join('\n'), /预览：Alpha/);
      assert.match(previewFrames.flat().join('\n'), /…（预览已截断）/);
      assert.match(previewFrames.flat().join('\n'), /Alt\+↑↓ 滚动 · /);
      s.send(keys.preview, keys.right); // Leave the first question unanswered until after later answers.
      assert.match(s.panel().join('\n'), /↑↓ 选择 · Space 勾选 · Enter 完成并下一题 · ←→ 切题 · Esc 取消/);
      focusChoice(s, 'Beta');
      s.send(' ');
      assertQuestion(s, 'MIDDLE_ORDER_PROMPT');
      focusChoice(s, '自定义回答');
      s.send(keys.enter, keys.enter);
      assert.match(s.panel().join('\n'), /请先填写内容。/);
      assert.match(s.panel().join('\n'), /Enter 保存 · Esc 返回/);
      s.send('extra', keys.enter);
      assertQuestion(s, 'MIDDLE_ORDER_PROMPT');
      assert.match(allPanelFrames(s).flat().join('\n'), /（自填）\s*extra/);
      s.send(keys.note, 'middle context', keys.enter, keys.right);
      assert.match(s.panel().join('\n'), /Beta[^\n]*（默认）/);
      s.send(keys.note, 'seed context', keys.enter, keys.left, keys.left);
      focusChoice(s, 'Beta');
      s.send(keys.enter);
      assertQuestion(s, 'MIDDLE_ORDER_PROMPT'); // Confirming the first question advances, it does not stay put.
      s.send(keys.left); // Deliberately revisit the first question to reanswer it.
      assert.match(activeTab(s), /First$/);
      focusChoice(s, 'Alpha');
      s.send(keys.enter);
      assertQuestion(s, 'MIDDLE_ORDER_PROMPT');
      s.send(keys.left);
      assert.match(activeTab(s), /First$/);
      s.send(keys.note, 'first context', keys.enter);
      assertQuestion(s, 'FIRST_ORDER_PROMPT');
      const review = previewQuestionOrder(s, questions);
      const reviewText = review.frames.flat().join('\n');
      assert.match(reviewText, /First[:：]\s*Alpha/);
      assert.match(reviewText, /Middle[:：]\s*（自填）\s*Beta, extra/);
      assert.match(reviewText, /Seeded[:：]\s*（默认）\s*Beta/);
      assertPreviewAction(s.panel(), true);
      const result = await complete(s);
      assertAnswerPipeline(s, result, review.ids, ['first', 'middle', 'seeded']);
      assert.equal(result.details.title, '请确认');
      assert.deepEqual(result.details.answers.map(({ value, values, wasDefault, wasCustom }) => ({ value, values, wasDefault, wasCustom })), [
        { value: 'a', values: undefined, wasDefault: undefined, wasCustom: false },
        { value: undefined, values: ['b', 'extra'], wasDefault: undefined, wasCustom: true },
        { value: 'b', values: undefined, wasDefault: true, wasCustom: false },
      ]);
      assert.deepEqual(result.details.notes, { first: 'first context', middle: 'middle context', seeded: 'seed context' });
      assert.deepEqual(result.details.skippedIds, []);
      assert.deepEqual(result.details.unresolvedRequiredIds, []);
      assert.match(result.content[0].text, /"typed":true/);
      assert.match(result.content[0].text, /"default":true/);
      const transcript = s.transcript(result).join('\n');
      assert.match(transcript, /Middle: （自填）/);
      assert.match(transcript, /Seeded: （默认）/);
      assert.match(transcript, /附加说明：/);
      assert.deepEqual(questions, original);
    } finally { await s.close(); }
  });

  test(`actual ${mode} answer pipeline restores a skipped default in question order without treating remaining skips or notes as approval`, async () => {
    const questions = [single({ id: 'again', label: 'Again', prompt: 'ANSWER_AGAIN', allowCustom: true, defaultValue: 'b', description: 'Keep this context' }),
      { id: 'kept', label: 'Kept', prompt: 'KEEP_TEXT', kind: 'text', description: 'Keep this too' },
      single({ id: 'required', label: 'Required', prompt: 'REQUIRED_CHOICE' }),
      single({ id: 'optional', label: 'Optional', prompt: 'OPTIONAL_CHOICE', kind: 'multi', required: false })];
    const original = structuredClone(questions);
    const s = await start(questions, { fullscreen, columns: 160, rows: 24 });
    try {
      s.send(keys.note, 'original context', keys.enter, keys.skip);
      assertQuestion(s, 'ANSWER_AGAIN');
      assert.match(allPanelFrames(s).flat().join('\n'), /已跳过 · 仍待确认/);
      s.send(keys.right, keys.enter, 'kept answer', keys.enter);
      assertQuestion(s, 'REQUIRED_CHOICE'); // The text answer saves and advances to the next question.
      s.send(keys.note, 'needs owner clarification', keys.enter, keys.skip, keys.right);
      assert.match(s.panel().join('\n'), /OPTIONAL_CHOICE\s*（可选）/);
      s.send(keys.note, 'optional context', keys.enter, keys.skip);
      assert.match(allPanelFrames(s).flat().join('\n'), /已跳过/);
      s.send(keys.left, keys.left, keys.left);
      focusChoice(s, '自定义回答');
      s.send(keys.enter, 'replacement', keys.enter);
      assertQuestion(s, 'KEEP_TEXT'); // A custom single answer saves and advances to the next question.
      s.send(keys.left); // Deliberately revisit the reanswered question to verify its note.
      assert.match(activeTab(s), /Again$/);
      s.send(keys.note);
      assert.match(s.panel().join('\n'), /original context/, 'Skip and reanswer must retain the independent saved note');
      s.send(keys.clear, 'revised context', keys.enter);
      const review = previewQuestionOrder(s, questions);
      assert.match(review.frames.flat().join('\n'), /Again[:：]\s*（自填）\s*replacement/);
      assert.match(review.frames.flat().join('\n'), /Required[:：]\s*已跳过 · 仍待确认/);
      assert.match(review.frames.flat().join('\n'), /Optional[:：]\s*已跳过/);
      assertPreviewAction(s.panel(), true);
      const result = await complete(s);
      assertAnswerPipeline(s, result, review.ids, ['again', 'kept']);
      assert.equal(result.details.cancelled, false);
      assert.deepEqual(result.details.answers.map(({ id, value, wasCustom, wasDefault }) => ({ id, value, wasCustom, wasDefault })), [
        { id: 'again', value: 'replacement', wasCustom: true, wasDefault: undefined },
        { id: 'kept', value: 'kept answer', wasCustom: true, wasDefault: undefined },
      ]);
      assert.deepEqual(result.details.notes, { again: 'revised context', required: 'needs owner clarification', optional: 'optional context' });
      assert.deepEqual(result.details.skippedIds, ['required', 'optional']);
      assert.deepEqual(result.details.unresolvedRequiredIds, ['required']);
      assert.match(result.content[0].text, /unresolvedRequiredIds=\["required"\]/);
      assert.match(result.content[0].text, /Skips and supplementary notes are not approval; do not proceed with actions that depend on those unanswered decisions\./);
      const transcript = s.transcript(result).join('\n');
      assert.match(transcript, /已跳过 · 仍待确认/);
      assert.match(transcript, /待确认：required。跳过和附加说明不代表批准。/);
      assert.deepEqual(questions, original);
    } finally { await s.close(); }
  });

  test(`actual ${mode} cancellation retains questionnaire-ordered answers and metadata after skip reanswer without publishing them as approval`, async (t) => {
    for (const cancellation of ['Esc', 'abort']) await t.test(cancellation, async () => {
      const questions = [single({ id: 'first', label: 'First', prompt: 'CANCEL_FIRST' }),
        { id: 'second', label: 'Second', prompt: 'CANCEL_SECOND', kind: 'text' },
        single({ id: 'seeded', label: 'Seeded', defaultValue: 'b' }),
        single({ id: 'pending', label: 'Pending' }), single({ id: 'optional', label: 'Optional', required: false })];
      const original = structuredClone(questions);
      const s = await start(questions, { fullscreen, columns: 160, rows: 24 });
      try {
        s.send(keys.note, 'retained context', keys.enter, keys.skip, keys.right);
        s.send(keys.enter, 'saved text', keys.enter, keys.right); // The text answer advances to Seeded.
        s.send(keys.note, 'unresolved context', keys.enter, keys.skip);
        s.send(keys.left, keys.left, keys.left, keys.down, keys.enter);
        assertQuestion(s, 'CANCEL_SECOND'); // Enter on the first question saves it and advances.
        s.send(keys.left); // Deliberately revisit the first question before cancelling.
        assertQuestion(s, 'CANCEL_FIRST');
        const review = previewQuestionOrder(s, questions);
        assert.deepEqual(review.ids, ['first', 'second', 'seeded', 'pending', 'optional']);
        if (cancellation === 'Esc') s.send(keys.esc);
        else {
          s.send(keys.right, keys.note, 'discarded draft'); // Preview wraps back to the first question.
          s.controller.abort();
        }
        const result = await s.promise;
        await new Promise((resolve) => setImmediate(resolve));
        s.assertRestored();
        s.assertResultContract(result);
        assert.equal(result.details.cancelled, true);
        assert.deepEqual(result.details.answers.map(({ id }) => id), ['first', 'second', 'seeded']);
        assert.equal(result.details.answers[0].value, 'b');
        assert.equal(result.details.answers[0].wasCustom, false);
        assert.equal(result.details.answers[1].value, 'saved text');
        assert.equal(result.details.answers[1].wasCustom, true);
        assert.equal(result.details.answers[2].wasDefault, true);
        assert.equal(result.details.answers[2].wasCustom, false);
        assert.deepEqual(result.details.notes, { first: 'retained context', pending: 'unresolved context' });
        assert.deepEqual(result.details.skippedIds, ['pending']);
        assert.deepEqual(result.details.unresolvedRequiredIds, ['pending']);
        assert.deepEqual(result.content, [{ type: 'text', text: 'User cancelled the questions' }]);
        for (const expanded of [false, true]) {
          const transcript = s.transcript(result, expanded).join('\n');
          assert.match(transcript, /已取消/);
          assert.doesNotMatch(transcript, /✓ |Cancelled|saved text|retained context|discarded draft/);
        }
        const error = await tool.execute('host-error', { questions }, undefined, undefined, { mode: 'json', hasUI: false });
        assert.match(error.content[0].text, /^Error: /, 'model error content remains English');
        assert.match(s.transcript(error).join('\n'), /错误：UI not available/);
        assert.deepEqual(questions, original);
      } finally { await s.close(); }
    });
  });

  test(`actual ${mode} every answer kind returns a four-field question projection without mutating rich input`, async () => {
    const questions = [single({ id: 'single', label: 'Decision', description: 'Decision context\n范围👩‍💻', options: [
      { value: 'a', label: 'Alpha', description: 'Alpha explanation', preview: 'const choice = "a";\n'.repeat(40) },
      { value: 'b', label: 'Beta', description: 'Beta explanation' },
    ] }), single({ id: 'multi', kind: 'multi', description: 'Multiple choice context', defaultValue: 'b' }),
    { id: 'text', kind: 'text', prompt: 'Written context?', description: 'Text context\n补充说明', required: false }];
    const original = structuredClone(questions);
    const s = await start(questions, { fullscreen, columns: 100, rows: 24, title: 'Result projection' });
    try {
      s.send(keys.preview);
      assert.ok(allPanelFrames(s).some((frame) => frame.some((line) => line.includes('const choice = "a";'))),
        'the large single-option preview must actually be rendered before projecting the result');
      s.send(keys.preview, keys.note, 'independent context', keys.enter);
      assertQuestion(s, 'Choose');
      s.send(keys.enter); // The single answer saves and advances to the multi question.
      assert.match(activeTab(s), /Q2$/);
      s.send(keys.right);
      assert.match(activeTab(s), /Q3$/);
      s.send(keys.enter, 'written answer', keys.enter);
      assertPreviewTab(s); // Saving the last answer lands on the review page.
      const result = await complete(s);
      assert.deepEqual(result.details.questions, [
        { id: 'single', label: 'Decision', kind: 'single', required: true },
        { id: 'multi', label: 'Q2', kind: 'multi', required: true },
        { id: 'text', label: 'Q3', kind: 'text', required: false },
      ]);
      const byId = Object.fromEntries(result.details.answers.map((answer) => [answer.id, answer]));
      assert.deepEqual(result.details.answers.map((answer) => answer.kind), ['single', 'multi', 'text']);
      assert.equal(byId.single.value, 'a');
      assert.deepEqual(byId.multi.values, ['b']);
      assert.equal(byId.multi.wasDefault, true);
      assert.equal(byId.text.value, 'written answer');
      assert.equal(byId.text.wasCustom, true);
      assert.deepEqual(result.details.notes, { single: 'independent context' });
      assert.deepEqual(questions, original, 'projection must not delete descriptions, options or previews from the input');
    } finally { await s.close(); }
  });

  test(`actual ${mode} terminal-control question descriptions stay in their own body without entering the title rule`, async () => {
    const description = '\x1b[35mSAFE_CONTEXT_0123456789\x1b[0m\x1b]0;CONTEXT_INJECTION\x07';
    const questions = [single({ defaultValue: 'b', description }), single({ id: 'next', label: 'Next', defaultValue: 'a' })];
    const original = structuredClone(questions);
    const s = await start(questions, { fullscreen, columns: 80, rows: 24, title: '权限确认' });
    try {
      const frames = allPanelFrames(s);
      for (const frame of frames) {
        assertTitleRule(frame, assertInline(s), '权限确认');
        assertBackgroundPlacement(frame, 'SAFE_CONTEXT_0123456789', 'Choose');
        assert.doesNotMatch(frame.raw[0], /\x1b\[35m|CONTEXT_INJECTION|\x1b\]0;/,
          'question descriptions and their caller terminal controls must not reach the title rule');
      }
      assert.ok(frames.some((frame) => frame.some((line) => line.trim() === 'SAFE_CONTEXT_0123456789')));
      s.send(keys.right);
      for (const frame of allPanelFrames(s)) assert.doesNotMatch(frame.raw.join('\n'), /SAFE_CONTEXT_|CONTEXT_INJECTION|\x1b\[35m|\x1b\]0;/,
        'the first description and its terminal controls must not enter the next question');
      focusPreview(s);
      for (const frame of allPanelFrames(s)) assert.doesNotMatch(frame.raw.join('\n'), /SAFE_CONTEXT_|CONTEXT_INJECTION|\x1b\[35m|\x1b\]0;/,
        'the final preview must not copy description content or caller controls');
      const result = await complete(s);
      assert.deepEqual(questions, original, 'display sanitation must not rewrite the input description');
      assert.equal(result.details.answers[0].value, 'b');
    } finally { await s.close(); }
  });

  test(`actual ${mode} long question descriptions page in the first body without hiding choices or the independent note cursor`, async () => {
    const markers = Array.from({ length: 22 }, (_, i) => `QUESTION_BG_${String(i).padStart(2, '0')}`);
    const description = [...markers.map((marker) => `${marker} ${'wrapped background '.repeat(4)}`), 'FIRST_OWN_DETAIL'].join('\n');
    const backgroundLines = new Set(wrapTextWithAnsi(description, 39).map((line) => line.trim()));
    const title = '完整背景';
    const questions = [single({ label: 'First', prompt: 'FIRST_PROMPT', defaultValue: 'b', description }),
      single({ id: 'next', label: 'Next', prompt: 'NEXT_PROMPT', defaultValue: 'a', description: 'NEXT_OWN_DETAIL' })];
    const original = structuredClone(questions);
    const s = await start(questions, { fullscreen, columns: 40, rows: 24, title });
    try {
      const bounds = assertInline(s);
      assert.ok(focusedChoice(s).includes('Beta'), 'focus must follow the answer, not the start of a long question description');
      assertAuxiliaryVisible(s);
      const above = s.screen().slice(0, bounds.row);
      const tab = activeTab(s);
      const frames = allPanelFrames(s);
      assert.ok(new Set(frames.map((frame) => frame.join('\n'))).size > 2, 'the question description must really page locally');
      for (const frame of frames) {
        assertTitleRule(frame, bounds, title);
        assertBackgroundPlacement(frame, backgroundLines, 'FIRST_PROMPT');
        assertTabGap(frame, bounds.height);
        assert.equal(activeTabFromFrame(frame), tab);
        assert.ok(frame.length <= 14);
        assert.ok(frame.some((line) => line.includes('[附加说明') && line.includes('[跳过')));
      }
      for (const line of backgroundLines) assert.ok(frames.some((frame) => frame.some((visible) => visible.trim() === line)),
        `every wrapped question-description continuation must remain reachable: ${line}`);
      for (const marker of [...markers, 'FIRST_PROMPT', 'FIRST_OWN_DETAIL']) assert.ok(frames.some((frame) => bodyFrame(frame).some((line) => line.includes(marker))),
        `${marker} must be readable in the first question body, not above the tabs`);
      const first = pageFrames(s, keys.altUp).at(-1);
      assertTabGap(first, bounds.height, 'FIRST_PROMPT');
      assert.deepEqual(s.screen().slice(0, bounds.row), above, 'local paging must not scroll the underlying chat');
      s.send(keys.note, '背景不替代回答', keys.left, keys.right);
      const editing = s.panel();
      assertTitleRule(editing, assertInline(s), title);
      assertBackgroundPlacement(editing, backgroundLines, 'FIRST_PROMPT');
      assert.ok(s.cursorVisible, 'long context must yield to the real note Editor cursor');
      assert.ok(bodyFrame(editing).some((line) => line.includes('背景不替代回答')));
      s.send(keys.enter, keys.right);
      for (const prompt of ['NEXT_PROMPT', '回答预览']) {
        const otherFrames = allPanelFrames(s);
        assert.ok(otherFrames.some((frame) => bodyFrame(frame).some((line) => line.includes(prompt))));
        for (const frame of otherFrames) {
          assertTitleRule(frame, assertInline(s), title);
          assertTabGap(frame, s.bounds().height);
          assert.ok(!frame.join('\n').includes('QUESTION_BG_'), 'other questions and preview must omit the first question description');
          if (prompt === '回答预览') assertPreviewAction(frame, true, true);
        }
        if (prompt === 'NEXT_PROMPT') {
          assert.ok(otherFrames.some((frame) => frame.some((line) => line.includes('NEXT_OWN_DETAIL'))));
          s.send(keys.right);
        }
      }
      assert.equal(s.active, true, 'paging preview is not submission');
      const result = await complete(s);
      assert.deepEqual(questions, original, 'paging, note editing and projection must retain the full input descriptions');
      assert.deepEqual(result.details.answers.map((answer) => answer.value), ['b', 'a']);
      assert.deepEqual(result.details.notes, { q: '背景不替代回答' });
      assert.deepEqual(result.details.skippedIds, []);
    } finally { await s.close(); }
  });


  test(`actual ${mode} auxiliary row stays pinned while content pages and Tab does not change question navigation`, async () => {
    const s = await start([single({ defaultValue: 'b', prompt: 'Context '.repeat(120) }),
      single({ id: 'other', defaultValue: 'a' })], { fullscreen, columns: 20, rows: 12 });
    try {
      assertAuxiliaryVisible(s);
      for (const frame of allPanelFrames(s)) {
        assert.ok(hasAuxiliaryRow(frame));
      }
      const tab = activeTab(s);
      s.send(keys.previousAction);
      assert.equal(focusedAuxiliary(s), 'skip');
      s.send(keys.down);
      assert.match(focusedChoice(s), /Beta/);
      s.send(keys.actions, keys.right);
      assert.equal(focusedAuxiliary(s), undefined);
      assert.match(focusedChoice(s), /Alpha/);
      s.send(keys.left);
      assert.equal(activeTab(s), tab);
      assert.match(focusedChoice(s), /Beta/);
      s.terminal.columns = 80;
      s.terminal.rows = 24;
      const result = await complete(s);
      assert.deepEqual(result.details.answers.map((answer) => answer.value), ['b', 'a']);
      assert.deepEqual(result.details.notes, {});
      assert.deepEqual(result.details.skippedIds, []);
    } finally { await s.close(); }
  });



  test(`actual ${mode} input dispatch pages an oversized choice`, async () => {
    const s = await start([single({ options: [
      { value: 'a', label: `${'Long '.repeat(16)}DISTINCT_END` }, { value: 'b', label: 'Beta' },
    ] })], { fullscreen, columns: 12, rows: 10 });
    try {
      const frames = [];
      for (let i = 0; i < 35; i++) {
        // Capture only the real inline region, never transcript or footer text.
        frames.push(s.panel());
        s.send(keys.altDown);
      }
      assert.ok(s.inputCalls >= 35, 'Pi must dispatch paging keys to the question component');
      const fragments = wrapTextWithAnsi('DISTINCT_END', s.terminal.columns - 2).map((line) => line.trim());
      let seenAt = 0;
      for (const fragment of fragments) {
        const index = frames.findIndex((frame, i) => i >= seenAt && bodyFrame(frame).some((line) => line.includes(fragment)));
        assert.ok(index >= 0, `actual inline pages must expose suffix fragment ${fragment}`);
        seenAt = index;
      }
      s.send(keys.up);
      assert.ok(s.screen().some((line) => line.includes('> ')));
    } finally { await s.close(); }
  });

  test(`actual ${mode} rendering keeps choices visible above tall below-editor widgets`, async () => {
    for (const rows of [8, 12, 24]) {
      const s = await start([single({ prompt: 'Context '.repeat(30) })], { fullscreen, rows, below: fullscreen ? 10 : Math.min(3, rows - 5) });
      try {
        assert.ok(s.screen().some((line) => line.includes('> ')), `active choice missing at height ${rows}`);
        s.send(keys.down);
        assert.ok(s.screen().some((line) => /> .*Beta/.test(line)), `next choice missing at height ${rows}`);
      } finally { await s.close(); }
    }
  });

  test(`actual ${mode} quiet preview screenshot distinguishes a missing required answer from untouched optional context`, async (t) => {
    const s = await start([
      single({ id: 'decision', label: 'Decision', required: true }),
      { id: 'context', label: 'Context', prompt: 'Optional context?', kind: 'text', required: false },
    ], { fullscreen, columns: 100, rows: 24 });
    try {
      const questionFrame = s.panel();
      assert.ok(questionFrame.raw.some((line) => line.includes(theme.fg('muted', ' 预览 '))),
        'even an incomplete preview tab is neutral muted, not ready-success');
      s.send(keys.right, keys.note, '   ', keys.enter, keys.right);
      assertPreviewTab(s);
      const bounds = assertInline(s);
      const frame = s.panel();
      t.diagnostic(`actual ${mode} quiet preview ${bounds.width}x${bounds.height}:\n${frame.join('\n')}`);
      assert.match(frame.join('\n'), /回答预览[^\n]*1 项待处理/);
      assert.match(frame.join('\n'), /Decision[:：]\s*待回答/);
      assert.match(frame.join('\n'), /Context[:：]\s*未填写 · 可选/);
      assert.ok(frame.raw.some((line) => line.includes(theme.fg('muted', '未填写 · 可选'))),
        'an untouched optional answer must be gray, not an amber unresolved decision');
      assert.doesNotMatch(frame.join('\n'), /已跳过|附加说明：|✓ Submit/,
        'a blank optional note is neither an answer nor an explicit Skip');
      assertPreviewAction(frame, false);
      assertQuietPreview(allPanelFrames(s));
      assertFixedRuleFrame(frame, bounds, 'quiet answer preview');
      s.send(keys.esc);
      const result = await s.promise;
      assert.equal(result.details.cancelled, true);
      assert.deepEqual(result.details.answers, []);
      assert.deepEqual(result.details.notes, {});
      assert.deepEqual(result.details.skippedIds, []);
      assert.deepEqual(result.details.unresolvedRequiredIds, ['decision']);
      s.assertRestored();
    } finally { await s.close(); }
  });

  test(`actual ${mode} repeated preview continuation finds the first real pending question and preserves all prior state`, async () => {
    const s = await start([
      single({ id: 'skipped', label: 'Skipped', required: true }),
      single({ id: 'answered', label: 'Answered', required: true }),
      single({ id: 'defaulted', label: 'Defaulted', required: true, defaultValue: 'b' }),
      single({ id: 'first', label: 'First pending', prompt: 'FIRST_PENDING', required: true,
        description: Array.from({ length: 12 }, (_, i) => `first context line ${i}`).join('\n') }),
      { id: 'second', label: 'Second pending', prompt: 'SECOND_PENDING', kind: 'text', required: true },
    ], { fullscreen, columns: 100, rows: 24 });
    try {
      s.send(keys.note, 'skipped context', keys.enter, keys.skip, keys.right);
      s.send(keys.note, 'answered context', keys.enter, keys.down, keys.enter); // Confirming advances to Defaulted.
      assert.match(focusedChoice(s), /Beta/);
      s.send(keys.note, 'default context', keys.enter, keys.right);
      s.send(keys.note, 'first context', keys.enter, keys.down);
      assert.match(focusedChoice(s), /Beta/, 'leave a nonpreferred unsaved choice focused');
      pageFrames(s, keys.altDown);
      s.send(keys.previousAction); // Leave Skip focused before navigating away.
      assert.equal(focusedAuxiliary(s), 'skip');
      s.send(keys.right, keys.note, 'second context', keys.enter, keys.right);
      assertPreviewTab(s);
      assert.match(s.panel().join('\n'), /回答预览[^\n]*2 项待处理/,
        'a skipped required question is unresolved but must not count as a continuation target');
      const reviewFrames = allPanelFrames(s);
      assertQuietPreview(reviewFrames);
      for (const note of ['skipped context', 'answered context', 'default context', 'first context', 'second context']) {
        assert.ok(reviewFrames.some((frame) => frame.some((line) => line.includes(`附加说明：${note}`))),
          `the separate note line must survive review paging: ${note}`);
      }
      s.send(keys.enter);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(s.active, true, 'continuing an incomplete preview must not submit');
      assert.match(activeTab(s), /First pending$/,
        'continuation must search questionnaire order, ignoring answered, defaulted, and explicitly skipped questions');
      assert.match(focusedChoice(s), /Alpha/, 'continuation restores preferredOptionIndex, not the stale Beta index');
      assert.equal(focusedAuxiliary(s), undefined);
      assert.equal(s.cursorVisible, false, 'continuation must not automatically edit');
      assert.doesNotMatch(s.panel().join('\n'), /Answer or|Enter 保存/);
      assert.match(s.panel().join('\n'), /> .*Alpha/, 'local offset must reveal the preferred choice after returning from paged review');
      assertQuestion(s, 'FIRST_PENDING');
      s.send(keys.note);
      assert.match(s.panel().join('\n'), /first context/, 'the pending question retains its existing note');
      s.send(keys.enter, keys.enter); // Save the unchanged note, then explicitly answer Alpha.
      assertQuestion(s, 'SECOND_PENDING'); // Answering the pending question advances to the text question.
      focusPreview(s);
      assert.match(s.panel().join('\n'), /回答预览[^\n]*1 项待处理/);
      s.send(keys.enter);
      await new Promise((resolve) => setImmediate(resolve));
      assertQuestion(s, 'SECOND_PENDING');
      assert.equal(s.cursorVisible, false, 'even text continuation requires an explicit editing action');
      assert.match(focusedChoice(s), /自定义回答/);
      s.send(keys.note);
      assert.match(s.panel().join('\n'), /second context/);
      s.send(keys.enter, keys.enter, 'second answer', keys.enter);
      assertPreviewTab(s); // The last pending answer lands on the review page.
      focusPreview(s);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(s.active, true, 'answering the last pending question and opening preview must not implicitly submit');
      assert.doesNotMatch(s.panel().join('\n'), /\d+ 项待处理/);
      assertPreviewAction(s.panel(), true);
      const result = await complete(s);
      assert.equal(result.details.cancelled, false);
      assert.deepEqual(result.details.answers.map(({ id }) => id), ['answered', 'defaulted', 'first', 'second']);
      const byId = Object.fromEntries(result.details.answers.map((answer) => [answer.id, answer]));
      assert.equal(byId.answered.value, 'b');
      assert.equal(byId.defaulted.value, 'b');
      assert.equal(byId.defaulted.wasDefault, true, 'default provenance must not be re-confirmed away');
      assert.equal(byId.first.value, 'a');
      assert.equal(byId.second.value, 'second answer');
      assert.deepEqual(result.details.notes, {
        skipped: 'skipped context', answered: 'answered context', defaulted: 'default context',
        first: 'first context', second: 'second context',
      });
      assert.deepEqual(result.details.skippedIds, ['skipped']);
      assert.deepEqual(result.details.unresolvedRequiredIds, ['skipped']);
      const model = result.content.map((part) => part.text || '').join('\n');
      assert.match(model, /unresolvedRequiredIds=\["skipped"\]/);
      assert.match(model, /not approval/i);
      assert.match(model, /do not proceed/i);
    } finally { await s.close(); }
  });

  test(`actual ${mode} explicitly skipped required preview allows partial submission while keeping only the short status amber`, async () => {
    const s = await start([
      single({ id: 'required', label: 'Required', required: true }),
      single({ id: 'optional', label: 'Optional', required: false }),
      single({ id: 'untouched', label: 'Untouched', required: false }),
    ], { fullscreen, columns: 100, rows: 24 });
    try {
      s.send(keys.note, 'needs owner clarification', keys.enter, keys.skip, keys.right, keys.skip, keys.right);
      assert.ok(s.panel().raw.some((line) => line.includes(theme.fg('muted', ' 预览 '))),
        'an eligible preview tab must still be neutral, never success-colored');
      s.send(keys.right);
      assertPreviewTab(s);
      const bounds = assertInline(s);
      const frame = s.panel();
      assert.match(frame.join('\n'), /回答预览/);
      assert.match(frame.join('\n'), /Required[:：]\s*已跳过 · 仍待确认/);
      assert.match(frame.join('\n'), /Optional[:：]\s*已跳过/);
      assert.match(frame.join('\n'), /Untouched[:：]\s*未填写 · 可选/);
      assert.match(frame.join('\n'), /附加说明：needs owner clarification/);
      assert.doesNotMatch(frame.join('\n'), /\d+ 项待处理/,
        'explicitly skipped required questions must not trigger a continuation loop');
      const requiredRow = frame.raw.find((line) => /Required[:：]/.test(stripTerminalSequences(line)));
      assert.ok(requiredRow?.includes(theme.fg('warning', '已跳过 · 仍待确认')),
        'the unresolved skipped status must remain amber');
      assert.ok(!requiredRow.slice(0, requiredRow.indexOf('Required')).includes(theme.getFgAnsi('warning')),
        'amber belongs to the short status only, not the entire answer label or note');
      assert.ok(frame.raw.some((line) => line.includes(theme.fg('muted', '附加说明：needs owner clarification'))));
      assertPreviewAction(frame, true);
      assertQuietPreview(allPanelFrames(s));
      assertFixedRuleFrame(frame, bounds, 'partial answer preview');
      const result = await complete(s);
      assert.equal(result.details.cancelled, false);
      assert.deepEqual(result.details.answers, []);
      assert.deepEqual(result.details.notes, { required: 'needs owner clarification' });
      assert.deepEqual(result.details.skippedIds, ['required', 'optional']);
      assert.deepEqual(result.details.unresolvedRequiredIds, ['required']);
      const model = result.content.map((part) => part.text || '').join('\n');
      assert.match(model, /unresolvedRequiredIds=\["required"\]/);
      assert.match(model, /Required questions remain unresolved/i);
      assert.match(model, /not approval/i);
      assert.match(model, /do not proceed with actions that depend on those unanswered decisions/i);
    } finally { await s.close(); }
  });

  test(`actual ${mode} short narrow paged review keeps the primary Enter action ahead of scroll hints`, async () => {
    const note = ['saved context', 'SUMMARY_HEAD', ...Array.from({ length: 24 }, (_, i) => `summary line ${i}`), 'SUMMARY_TAIL'].join('\n');
    for (const [columns, rows] of [[20, 12], [40, 8], [100, 24]]) {
      const s = await start([
        single({ id: 'saved', label: 'Saved', defaultValue: 'b', options: [
          { value: 'a', label: 'Alpha' }, { value: 'b', label: 'Saved long answer '.repeat(6).trim() },
        ] }),
        single({ id: 'pending', label: 'Pending', required: true }),
      ], { fullscreen, columns, rows });
      try {
        s.send(keys.note, `\x1b[200~${note}\x1b[201~`, keys.enter);
        focusPreview(s);
        const bounds = assertInline(s);
        for (const ready of [false, true]) {
          const frames = allPanelFrames(s);
          assert.ok(new Set(frames.map((frame) => frame.join('\n'))).size > 2,
            `${columns}x${rows} must exercise actual local review paging`);
          assert.ok(frames.some((frame) => frame.some((line) => line.includes('SUMMARY_HEAD'))));
          assert.ok(frames.some((frame) => frame.some((line) => line.includes('SUMMARY_TAIL'))));
          for (const frame of frames) {
            assert.equal(activeTabFromFrame(frame), '预览');
            assertPreviewAction(frame, ready, columns < 100);
            assertFixedRuleFrame(frame, bounds, `${columns}x${rows} ${ready ? 'ready' : 'pending'} paged review`);
          }
          assertQuietPreview(frames);
          if (!ready) {
            s.send(keys.enter);
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(s.active, true);
            assert.match(activeTab(s), /Pending$/);
            assert.match(focusedChoice(s), /Alpha/);
            assert.equal(s.cursorVisible, false);
            s.send(keys.enter);
            assert.equal(s.active, true, 'answering after a paged preview does not submit');
            focusPreview(s);
          }
        }
        const result = await complete(s);
        assert.equal(result.details.cancelled, false);
        assert.deepEqual(result.details.notes, { saved: note });
        assert.equal(result.details.answers.find((answer) => answer.id === 'saved').value, 'b');
        assert.equal(result.details.answers.find((answer) => answer.id === 'saved').wasDefault, true);
        assert.equal(result.details.answers.find((answer) => answer.id === 'pending').value, 'a');
        assert.deepEqual(result.details.skippedIds, []);
        assert.deepEqual(result.details.unresolvedRequiredIds, []);
      } finally { await s.close(); }
    }
  });
}

test('layout measurement renders each host sibling exactly once per frame', async () => {
  for (const fullscreen of [false, true]) {
    const s = await start([single({ id: 'one' }), single({ id: 'two' }), single({ id: 'three' })], { fullscreen, columns: 100, rows: 24 });
    try {
      s.screen();
      const before = s.renderCounts();
      s.component.render(100);
      const after = s.renderCounts();
      const delta = Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - before[key]]));
      // The transcript is never measured; a single frame must not measure siblings twice.
      assert.equal(delta.document, 0, 'the transcript must never be measured');
      const measured = fullscreen ? ['pending', 'status', 'above', 'below', 'footer'] : ['below', 'footer'];
      for (const key of measured) assert.equal(delta[key], 1, `${key} must be measured exactly once per frame`);
      for (const key of Object.keys(delta)) {
        if (!measured.includes(key)) assert.equal(delta[key], 0, `${key} must not be measured`);
      }
    } finally { await s.close(); }
  }
});
