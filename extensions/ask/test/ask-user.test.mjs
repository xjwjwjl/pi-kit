import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';

const root = new URL('../node_modules/@earendil-works/', import.meta.url);
const imp = (suffix) => import(new URL(suffix, root).href);
const { loadExtensions } = await imp('pi-coding-agent/dist/core/extensions/loader.js');
const { validateToolArguments } = await imp('pi-ai/dist/utils/validation.js');
const { wrapToolDefinition } = await imp('pi-coding-agent/dist/core/tools/tool-definition-wrapper.js');
const { getThemeByName } = await imp('pi-coding-agent/dist/modes/interactive/theme/theme.js');
const { KeybindingsManager } = await imp('pi-coding-agent/dist/core/keybindings.js');
const { TuiMainScreen, CURSOR_MARKER, stripTerminalSequences, setKeybindings, setKittyProtocolActive, visibleWidth } = await imp('pi-tui/dist/index.js');
const { getInlineMaxHeight } = await import('../src/viewport.ts');
const loaded = await loadExtensions(
  [fileURLToPath(new URL('../index.ts', import.meta.url))],
  fileURLToPath(new URL('../', import.meta.url)),
);
assert.deepEqual(loaded.errors, []);
const tool = loaded.extensions[0].tools.get('ask_user').definition;
const theme = getThemeByName('dark');
assert.ok(theme);
const kb = new KeybindingsManager();
setKeybindings(kb);
const key = { enter: '\r', down: '\x1b[B', up: '\x1b[A', left: '\x1b[D', right: '\x1b[C', tab: '\t', shiftTab: '\x1b[Z', esc: '\x1b', space: ' ', pageUp: '\x1b[5~', pageDown: '\x1b[6~', clear: '\x15', note: '\x0e', skip: '\x13', preview: '\x0f', actions: '\x1b[17~', previousAction: '\x1b[17;2~' };
const options = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }];
const single = (extra = {}) => ({ id: 'q', prompt: 'Choose a target', kind: 'single', options, allowCustom: false, ...extra });

function start(questions, { columns = 80, rows = 24, theme: componentTheme = theme, title, bindings = kb } = {}) {
  const terminal = { columns, rows, write() {}, hideCursor() {}, showCursor() {} };
  const tui = new TuiMainScreen(terminal, false);
  tui.requestRender = () => {};
  const controller = new AbortController();
  let component;
  let settled = false;
  let doneCalls = 0;
  let value;
  const context = { mode: 'tui', hasUI: true, ui: { custom(factory) {
    return new Promise((resolve, reject) => {
      let closed = false;
      const done = (result) => {
        doneCalls++;
        if (closed) return;
        closed = true;
        resolve(result);
        component?.dispose?.();
      };
      try {
        component = factory(tui, componentTheme, bindings, done);
        tui.setFocus(component);
      } catch (error) { reject(error); }
    });
  } } };
  const promise = tool.execute('review-call', { questions, ...(title === undefined ? {} : { title }) }, controller.signal, undefined, context);
  promise.then((result) => { settled = true; value = result; });
  assert.ok(component, 'expected custom component');
  return {
    controller, promise, component, terminal, theme: componentTheme,
    send: (...keys) => keys.forEach((k) => component.handleInput(k)),
    lines: (width = terminal.columns) => component.render(width),
    plain: (width = terminal.columns) => component.render(width).map(stripTerminalSequences),
    get settled() { return settled; },
    get doneCalls() { return doneCalls; },
    get value() { return value; },
    async cancel() { if (!settled) { component.handleInput(key.esc); component.handleInput(key.esc); } await promise; },
  };
}

function focusedLabel(s) {
  return s.plain().find((line) => /^\s*> /.test(line)) || '';
}

const SELECTED_SENTINEL = '%SELECTED%';

function auxiliaryIsFocused(s, token) {
  const bgPrefix = theme.bg('selectedBg', SELECTED_SENTINEL).split(SELECTED_SENTINEL)[0];
  return s.lines().some((line) => {
    const index = line.indexOf(bgPrefix);
    if (index < 0) return false;
    const segment = stripTerminalSequences(line.slice(index));
    return segment.startsWith(token) || segment.startsWith('[' + token);
  });
}

function focusAction(s, label) {
  if (label === 'Submit') { review(s); return; }
  for (const direction of [key.up, key.down]) {
    for (let i = 0; i < 32; i++) {
      if (focusedLabel(s).includes(label)) return;
      s.send(direction);
    }
  }
  assert.fail(`Cannot focus answer ${label}:\n${s.plain().join('\n')}`);
}

function activate(s, label) {
  if (label === 'Add note' || label === 'Edit note') { s.send(key.note); return; }
  if (label === 'Skip') { s.send(key.skip); return; }
  focusAction(s, label);
  s.send(key.enter);
}

function review(s) {
  for (let i = 0; i < 7; i++) {
    if (s.plain().some((line) => line.trim().startsWith('回答预览'))) return;
    s.send(key.right);
  }
  assert.fail('Submit review tab was not reachable');
}

test('native style: question content matches the installed Pi questionnaire demo in both themes', async () => {
  const reference = await loadExtensions(
    [fileURLToPath(new URL('pi-coding-agent/examples/extensions/questionnaire.ts', root))],
    fileURLToPath(new URL('../', import.meta.url)),
  );
  assert.deepEqual(reference.errors, []);
  const demo = reference.extensions[0].tools.get('questionnaire').definition;
  const questions = [single({ label: 'Scope', options: [
    { value: 'a', label: 'Alpha', description: 'First explanation' },
    { value: 'b', label: 'Beta', description: 'Second explanation' },
  ] }), single({ id: 'priority', label: 'Priority' })];
  for (const name of ['dark', 'light']) {
    const activeTheme = getThemeByName(name);
    const s = start(questions, { theme: activeTheme });
    const tui = new TuiMainScreen({ columns: 80, rows: 24, write() {} }, false);
    tui.requestRender = () => {};
    let demoComponent;
    const demoResult = demo.execute('native-style-reference', {
      questions: questions.map((question) => ({ ...question, allowOther: false })),
    }, undefined, undefined, { mode: 'tui', ui: { custom(factory) {
      return new Promise((done) => { demoComponent = factory(tui, activeTheme, kb, done); });
    } } });
    try {
      const expected = demoComponent.render(80);
      const help = expected.findIndex((line) => stripTerminalSequences(line).includes('Tab/←→ navigate'));
      assert.ok(help > 1, 'read the real demo content before its footer gap');
      const content = expected.slice(0, help - 1);
      // The total title shares the rule; the final tab is neutral. All question
      // content retains the real demo's spacing, theme roles and indentation.
      content[0] = activeTheme.fg('accent', '─') + activeTheme.fg('text', activeTheme.bold(' 请确认 '))
        + activeTheme.fg('accent', '─'.repeat(71));
      content[1] = content[1].replace(activeTheme.fg('dim', ' ✓ Submit '), activeTheme.fg('muted', ' 预览 '));
      assert.deepEqual(s.lines().slice(0, content.length), content,
        `${name}: rules, padded tabs, colors, indentation and blank lines must match the demo`);
      assert.equal(s.lines().at(-1), activeTheme.fg('accent', '─'.repeat(80)));
      assert.ok(s.lines().some((line) => line.includes(activeTheme.fg('muted', '[附加说明 Ctrl+N]'))));
      assert.ok(s.lines().some((line) => line.includes(activeTheme.fg('muted', '[跳过 Ctrl+S]'))));
    } finally {
      demoComponent?.handleInput(key.esc);
      await demoResult;
      await s.cancel();
    }
  }
});

test('native style: fixed rules yield only below eight allocated rows, preserving choices and IME cursor', async () => {
  const s = start([single({ defaultValue: 'b', allowCustom: true, options: [
    { value: 'a', label: 'Alpha', description: 'First explanation' },
    { value: 'b', label: 'Beta', description: 'Second explanation' },
  ] })]);
  try {
    assert.equal(s.plain().filter((line) => /^(?:─+|─ .+ ─+)$/.test(line)).length, 2);
    s.terminal.rows = 12;
    assert.equal(s.plain().length, 8);
    assert.equal(s.plain().filter((line) => /^(?:─+|─ .+ ─+)$/.test(line)).length, 2, 'eight actual rows keep the frame despite the long body');
    assert.match(focusedLabel(s), /Beta/, 'the saved default retains choice focus');
    s.terminal.rows = 11;
    const compact = s.plain();
    assert.equal(compact.length, 7);
    assert.equal(compact.filter((line) => /^─+$/.test(line)).length, 0, 'only an actually tiny slot drops the frame');
    assert.match(focusedLabel(s), /Beta/);
    s.terminal.rows = 24;
    s.send(key.note, '中文备注');
    const editing = s.plain();
    assert.match(editing[0], /^─ 请确认 ─+$/);
    assert.equal(visibleWidth(editing[0]), 80);
    assert.equal(editing.at(-1), '─'.repeat(80), 'note editing must keep the same outer boundary');
    const cursorRow = s.lines().findIndex((line) => line.includes(CURSOR_MARKER));
    assert.ok(cursorRow > 1 && cursorRow < editing.length - 2, 'the input cursor remains inside the framed body, before help');
    assert.ok(editing.some((line) => line.includes('中文备注')));
    s.terminal.rows = 6;
    assert.ok(s.lines().some((line) => line.includes(CURSOR_MARKER)), 'decoration must yield to the real editor cursor');
    assert.ok(s.lines().length <= getInlineMaxHeight(6));
    s.send(key.enter);
    s.terminal.rows = 24;
    s.send(key.enter);
    const result = await s.promise;
    assert.equal(result.details.answers[0].value, 'b');
    assert.equal(result.details.answers[0].wasDefault, true);
    assert.deepEqual(result.details.notes, { q: '中文备注' });
  } finally { await s.cancel(); }
});

test('native spacing: tab gap depends on allocated height, not single/multi choice or context counts', async () => {
  for (const kind of ['single', 'multi']) {
    for (const total of [5, 6]) {
      for (const description of [undefined, 'GROUP_CONTEXT']) {
        const question = single({ kind, label: 'Spacing', prompt: 'SPACING_PROMPT', allowCustom: true, description,
          options: Array.from({ length: total - 1 }, (_, i) => ({ value: `v${i}`, label: `Choice ${i + 1}` })) });
        // A tab row only exists for multi-question flows.
        const s = start([question, single({ id: 'second', label: 'Second' })]);
        try {
          for (const rows of [24, 11, 24]) {
            s.terminal.rows = rows;
            for (let page = 0; page < 32; page++) s.send(key.pageUp);
            const raw = s.lines(), plain = s.plain();
            const tab = raw.findIndex((line) => line.includes(theme.getBgAnsi('selectedBg')));
            const framed = rows >= 12;
            assert.ok(tab >= 0);
            if (framed) assert.equal(plain[tab + 1], '');
            assert.equal(plain[tab + (framed ? 2 : 1)], ' SPACING_PROMPT',
              `${kind}, ${total} choices, group=${Boolean(description)}, rows=${rows}: exactly one gap when framed, none when cramped`);
            assert.ok(plain.length <= getInlineMaxHeight(rows));
            assert.ok(plain.some((line) => line.includes('[附加说明') && line.includes('[跳过')));
            s.send(key.up); // Return to the same first answer after inspecting page zero.
            assert.match(focusedLabel(s), /Choice 1/);
          }
        } finally { await s.cancel(); }
      }
    }
  }
});

test('native header: only the title and tabs frame question-specific context', async () => {
  const title = '随便聊聊';
  for (const name of ['dark', 'light']) {
    const componentTheme = getThemeByName(name);
    const s = start([single({ defaultValue: 'b', description: '当前题说明' })], { title, theme: componentTheme });
    try {
      const raw = s.lines(), plain = s.plain();
      assert.match(plain[0], /^─ 随便聊聊 ─+$/);
      assert.equal(plain.filter((line) => line.includes('当前题说明')).length, 1);
      assert.ok(raw[0].includes(componentTheme.fg('text', componentTheme.bold(' 随便聊聊 '))));
      const tab = raw.findIndex((line) => line.includes(componentTheme.getBgAnsi('selectedBg')));
      // No tab row and no header gap: the body follows the title rule directly.
      assert.equal(tab, -1);
      assert.equal(plain[1], ' Choose a target');
      assert.equal(plain[2], ' 当前题说明');
      assert.ok(raw[2].includes(componentTheme.fg('muted', '当前题说明')));
      assert.match(focusedLabel(s), /Beta/);
      s.send(key.right);
      assert.match(s.plain().join('\n'), /当前题说明/, 'Tab cannot leave a single-question flow');
      s.send(key.enter);
      const result = await s.promise;
      assert.equal(result.details.title, title);
      assert.ok(!('description' in result.details));
      assert.deepEqual(result.details.questions, [{ id: 'q', label: 'Q1', kind: 'single', required: true }]);
      assert.ok(!('status' in result.details.answers[0]) && !('index' in result.details.answers[0]));
      assert.equal(result.details.answers[0].wasDefault, true);
      assert.equal(result.details.answers[0].value, 'b');
    } finally { await s.cancel(); }
  }
});

test('question context: resizing while editing preserves the note cursor, draft and unchanged default', async () => {
  const title = '范围确认', description = '与当前问题相关的必要背景。';
  const s = start([single({ defaultValue: 'b', description })], { title });
  try {
    s.send(key.note, '中文草稿');
    for (const columns of [80, 40, 20, 80]) {
      s.terminal.columns = columns;
      const raw = s.lines(), plain = s.plain();
      assert.equal(raw.filter((line) => line.includes(CURSOR_MARKER)).length, 1);
      assert.ok(plain.some((line) => line.includes('中文草稿')));
      assert.ok(raw.every((line) => visibleWidth(line) <= columns));
      assert.ok(raw.length <= 14);
      assert.ok(!plain[0].includes(description));
      assert.equal(s.doneCalls, 0, 'resize cannot save or submit a draft');
    }
    s.send(key.esc, key.note);
    assert.doesNotMatch(s.plain().join('\n'), /中文草稿/, 'discarded draft must not reappear after a layout transition');
    s.send('saved context', key.enter, key.right, key.enter);
    const result = await s.promise;
    assert.deepEqual(result.details.notes, { q: 'saved context' });
    assert.ok(!('description' in result.details));
    assert.equal(result.details.answers[0].value, 'b');
    assert.equal(result.details.answers[0].wasDefault, true);
    assert.deepEqual(result.details.unresolvedRequiredIds, []);
  } finally { await s.cancel(); }
});

test('native heading: Unicode titles share one bounded rule at every width without changing tool data', async () => {
  const title = '中文标题 👩‍💻 e\u0301 保留原文'.repeat(30);
  const s = start([single({ defaultValue: 'b' })], { title });
  try {
    for (let columns = 1; columns <= 160; columns++) {
      s.terminal.columns = columns;
      const lines = s.lines();
      const plain = s.plain();
      assert.equal(visibleWidth(lines[0]), columns, `${columns}: the heading must fill exactly one line`);
      assert.ok(lines.length <= 14);
      assert.ok(lines.every((line) => visibleWidth(line) <= columns && !/[\r\n]/.test(line)));
      // An inline widget pads to its allocated height; only the last non-empty
      // line must close the frame.
      const trimmed = [...plain];
      while (trimmed.length && trimmed.at(-1) === '') trimmed.pop();
      assert.equal(trimmed.at(-1), '─'.repeat(columns));
      assert.match(plain[0], columns < 8 ? /^─+$/ : /^─ .+ ─+$/);
      if (columns >= 20) assert.match(focusedLabel(s), /Beta/, 'decorations cannot displace the saved default');
    }
    s.send(key.enter);
    const result = await s.promise;
    assert.equal(result.details.title, title, 'display truncation must not rewrite caller data');
    assert.equal(result.details.answers[0].value, 'b');
    assert.equal(result.details.answers[0].wasDefault, true);
  } finally { await s.cancel(); }
});

test('auxiliary controls: Tab exposes and executes note and skip even in a one-row slot', async () => {
  // Skip only exists with more than one question, so this uses a two-question flow.
  const s = start([single({ defaultValue: 'b' }), single({ id: 'other', defaultValue: 'a' })], { columns: 22, rows: 5 });
  try {
    assert.match(focusedLabel(s), /Beta/);
    s.send(key.tab);
    assert.equal(s.plain().length, 1);
    assert.match(s.plain()[0], /附加说明/);
    assert.match(s.plain()[0], /跳过/);
    assert.equal(focusedLabel(s), '', 'auxiliary controls never acquire the answer marker');
    assert.ok(auxiliaryIsFocused(s, '附加说明'));
    s.send(key.enter, 'one-row note');
    assert.ok(s.lines().some((line) => line.includes(CURSOR_MARKER)));
    s.send(key.actions, key.previousAction); // Active Editor must keep these keys (Tab would open completion).
    assert.ok(s.lines().some((line) => line.includes(CURSOR_MARKER)));
    s.send(key.enter);
    assert.ok(auxiliaryIsFocused(s, '附加说明'));
    assert.equal(s.settled, false, 'saving a note never submits');
    s.terminal.rows = 24;
    s.terminal.columns = 80;
    s.send(key.up); // Return to the answers, then confirm the saved default.
    s.send(key.enter, key.enter); // First answer, then the second question's default.
    review(s);
    s.send(key.enter);
    const result = await s.promise;
    assert.equal(result.details.answers[0].value, 'b');
    assert.deepEqual(result.details.notes, { q: 'one-row note' });
    assert.deepEqual(result.details.skippedIds, []);
  } finally { await s.cancel(); }
});

test('auxiliary controls: reverse focus, arrows and question tabs preserve the answer', async () => {
  const s = start([single({ defaultValue: 'b' }), single({ id: 'other', defaultValue: 'a' })]);
  try {
    s.send(key.actions, key.previousAction);
    assert.match(focusedLabel(s), /Beta/);
    s.send(key.previousAction); // Reverse from answers reaches Skip directly.
    assert.equal(focusedLabel(s), '');
    s.send(key.up); // Return to answers without changing the saved default.
    assert.match(focusedLabel(s), /Beta/);
    s.send(key.actions, key.right);
    assert.match(focusedLabel(s), /Alpha/, '←/→ still change questions instead of cycling action buttons');
    s.send(key.left);
    assert.match(focusedLabel(s), /Beta/);
    review(s);
    s.send(key.enter);
    const result = await s.promise;
    assert.deepEqual(result.details.answers.map((answer) => answer.value), ['b', 'a']);
    assert.ok(result.details.answers.every((answer) => answer.wasDefault));
    assert.deepEqual(result.details.notes, {});
    assert.deepEqual(result.details.skippedIds, []);
  } finally { await s.cancel(); }
});

test('answer preview: pending and skipped decisions stay distinct and model restrictions survive', async () => {
  const s = start([single({ id: 'decision', label: '交互类型' }),
    { id: 'context', label: '备注', prompt: 'Optional context', kind: 'text', required: false }]);
  try {
    s.send(key.note, 'context only', key.enter);
    review(s);
    const pending = s.plain().join('\n');
    assert.match(pending, /回答预览.*1 项待处理/);
    assert.match(pending, /交互类型: 待回答/);
    assert.match(pending, /备注: 未填写 · 可选/);
    assert.match(pending, /附加说明：context only/);
    assert.match(pending, /Enter 继续回答/);
    assert.doesNotMatch(pending, /Ready to submit|Unresolved required|not approval|Answer or|Enter submit/);
    s.send(key.enter);
    assert.equal(s.doneCalls, 0);
    assert.match(focusedLabel(s), /Alpha/);
    assert.ok(!s.lines().some((line) => line.includes(CURSOR_MARKER)), 'continuing does not start an editor');
    s.send(key.skip);
    review(s);
    const partial = s.plain().join('\n');
    assert.match(partial, /交互类型: 已跳过 · 仍待确认/);
    assert.match(partial, /Enter 提交回答/);
    assert.doesNotMatch(partial, /项待处理|not approval|Unresolved required/);
    s.send(key.enter);
    const result = await s.promise;
    assert.deepEqual(result.details.answers, []);
    assert.deepEqual(result.details.notes, { decision: 'context only' });
    assert.deepEqual(result.details.skippedIds, ['decision']);
    assert.deepEqual(result.details.unresolvedRequiredIds, ['decision']);
    assert.match(result.content[0].text, /not approval/);
    assert.match(result.content[0].text, /do not proceed/);
  } finally { await s.cancel(); }
});

test('answer preview: the full primary action survives narrow paged summaries', async () => {
  for (const columns of [12, 18, 20, 40]) {
    const s = start([single({ id: 'first', defaultValue: 'b' }), single({ id: 'missing' })], { columns });
    try {
      s.send(key.note, 'Long supplementary context '.repeat(100), key.enter);
      review(s);
      for (const ready of [false, true]) {
        const before = s.plain().join('\n');
        for (let page = 0; page < 32; page++) {
          const legend = s.plain().find((line) => /^\s*Enter /.test(line)) || '';
          assert.match(legend, ready ? /Enter 提交(?:回答)?(?:\s|$)/ : /Enter (?:继续回答|补答)(?:\s|$)/,
            `${columns} columns: scrolling help must not truncate the primary action: ${legend}`);
          s.send(key.pageDown);
        }
        assert.notEqual(s.plain().join('\n'), before, 'the summary must really overflow and page');
        if (!ready) {
          s.send(key.enter);
          assert.equal(s.doneCalls, 0);
          assert.match(focusedLabel(s), /Alpha/);
          s.send(key.enter);
          review(s);
        }
      }
      s.send(key.enter);
      const result = await s.promise;
      assert.deepEqual(result.details.answers.map((answer) => answer.value), ['b', 'a']);
      assert.deepEqual(result.details.unresolvedRequiredIds, []);
    } finally { await s.cancel(); }
  }
});

test('registration: the legacy entrypoint preserves the package tool contract', async () => {
  const legacy = await loadExtensions(
    [fileURLToPath(new URL('../ask_user.ts', import.meta.url))],
    fileURLToPath(new URL('../', import.meta.url)),
  );
  assert.deepEqual(legacy.errors, []);
  const previousPathTool = legacy.extensions[0].tools.get('ask_user').definition;
  assert.equal(previousPathTool.name, tool.name);
  assert.deepEqual(previousPathTool.parameters, tool.parameters);
  assert.equal(previousPathTool.exposure, tool.exposure);
  assert.equal(previousPathTool.executionMode, tool.executionMode);
});

test('registration: explicit kinds expose strict per-question contracts, without a shared description', () => {
  assert.ok(!('description' in tool.parameters.properties));
  assert.equal(tool.parameters.additionalProperties, false);
  assert.match(tool.promptGuidelines.join('\n'), /Always specify kind/);
  const branches = tool.parameters.properties.questions.items.anyOf;
  assert.deepEqual(branches.map((branch) => branch.properties.kind.const), ['text', 'single', 'multi']);
  for (const branch of branches) {
    assert.ok(branch.required.includes('kind'));
    assert.equal(branch.additionalProperties, false);
    assert.match(branch.properties.description.description, /shown below the prompt/);
  }
});

test('registration: asks are sequential and model-only', () => {
  assert.equal(tool.executionMode, 'sequential');
  assert.equal(tool.exposure, 'model-only');
});

test('performance: unchanged boundary navigation preserves the rendered frame', async () => {
  const s = start([single({ options: [
    { value: 'a', label: 'Alpha', preview: '字'.repeat(40_000) }, options[1],
  ] })]);
  try {
    const first = s.lines();
    s.send(key.up); // Already on the first answer.
    assert.equal(s.lines(), first);
    // Single-question flows have no tab row, so ←/→ cannot move the frame.
    s.send(key.left, key.right);
    assert.equal(s.lines(), first);
    s.send(key.down, key.down); // Move to the last answer.
    const last = s.lines();
    s.send(key.down); // Already on the last answer.
    assert.equal(s.lines(), last);
  } finally { await s.cancel(); }
});

// Baseline behavior: these are expected to pass.
test('baseline: single-select returns the chosen stable value', async () => {
  const s = start([single()]);
  s.send(key.down, key.enter);
  assert.equal(s.doneCalls, 1, 'a single-question flow submits as soon as the answer is confirmed');
  const result = await s.promise;
  assert.equal(result.details.answers[0].value, 'b');
  assert.equal(result.details.cancelled, false);
});

test('baseline: free-text, optional skip, and submit work across tabs', async () => {
  const s = start([
    { id: 'text', prompt: 'Write a note', kind: 'text' },
    single({ id: 'optional', required: false }),
  ]);
  s.send(key.enter, 'hello', key.enter); // saving the text advances to the next question
  activate(s, 'Skip');
  s.send(key.right, key.enter); // Review, then Submit
  const result = await s.promise;
  assert.equal(result.details.answers[0].value, 'hello');
  assert.deepEqual(result.details.skippedIds, ['optional']);
});

test('advance: Enter confirms in question order and lands on the review page', async () => {
  const s = start([
    single({ id: 'first', prompt: 'FIRST_ADVANCE' }),
    single({ id: 'second', prompt: 'SECOND_ADVANCE' }),
    single({ id: 'third', prompt: 'THIRD_ADVANCE' }),
  ]);
  try {
    s.send(key.enter);
    assert.match(s.plain().join('\n'), /SECOND_ADVANCE/);
    s.send(key.enter);
    assert.match(s.plain().join('\n'), /THIRD_ADVANCE/);
    assert.match(s.plain().join('\n'), /Enter 确认并预览/, 'the last question announces the next stop');
    s.send(key.enter);
    assert.match(s.plain().join('\n'), /回答预览/, 'answering the last question lands on the review page');
    assert.equal(s.settled, false, 'reaching the review page is not a submission');
    s.send(key.enter);
    const result = await s.promise;
    assert.deepEqual(result.details.answers.map(({ id }) => id), ['first', 'second', 'third']);
  } finally { await s.cancel(); }
});

test('advance: Space toggles multi choices while Enter finishes, and a required empty multi stays', async () => {
  const s = start([
    single({ id: 'multi', kind: 'multi', prompt: 'MULTI_ADVANCE', allowCustom: false }),
    single({ id: 'next', prompt: 'NEXT_AFTER_MULTI' }),
  ]);
  try {
    s.send(key.enter);
    assert.match(s.plain().join('\n'), /MULTI_ADVANCE/);
    assert.match(s.plain().join('\n'), /请先选择一项，或按 Ctrl\+S 跳过。/);
    assert.ok(!s.plain().some((line) => line.includes('[x] Alpha')), 'Enter must not toggle a multi choice');
    s.send(key.space);
    assert.match(s.plain().join('\n'), /\[x\] Alpha/);
    s.send(key.enter);
    assert.match(s.plain().join('\n'), /NEXT_AFTER_MULTI/);
    s.send(key.enter); // Answer the final required question before review.
    review(s);
    s.send(key.enter);
    const result = await s.promise;
    assert.deepEqual(result.details.answers[0].values, ['a']);
  } finally { await s.cancel(); }
});

test('advance: a saved note stays on its question while a text answer advances', async () => {
  const s = start([
    { id: 'text', prompt: 'TEXT_ADVANCE', kind: 'text' },
    single({ id: 'after', prompt: 'AFTER_TEXT' }),
  ]);
  try {
    activate(s, 'Add note');
    s.send('stays here', key.enter);
    assert.match(s.plain().join('\n'), /TEXT_ADVANCE/);
    assert.match(s.plain().join('\n'), /附加说明：stays here/);
    s.send(key.enter, 'typed answer', key.enter);
    assert.match(s.plain().join('\n'), /AFTER_TEXT/);
    s.send(key.enter); // Answer the final required question before review.
    review(s);
    s.send(key.enter);
    const result = await s.promise;
    assert.equal(result.details.answers.find(({ id }) => id === 'text').value, 'typed answer');
    assert.deepEqual(result.details.notes, { text: 'stays here' });
  } finally { await s.cancel(); }
});


test('baseline: non-TUI invocation returns an explicit error', async () => {
  const result = await tool.execute('review-print', { questions: [single()] }, undefined, undefined, { mode: 'print', hasUI: false });
  assert.equal(result.isError, true);
  assert.equal(result.details.error, 'UI not available');
});

test('baseline: duplicate question ids are rejected', async () => {
  const result = await tool.execute('review-invalid', { questions: [single(), single()] }, undefined, undefined, { mode: 'tui' });
  assert.equal(result.isError, true);
  assert.match(result.details.error, /Duplicate question id/);
});

test('strict input: prevalidation rejects raw errors before the host can coerce them', () => {
  const runtimeTool = wrapToolDefinition(tool);
  assert.equal(runtimeTool.prepareArguments, tool.prepareArguments, 'the native wrapper must preserve raw validation');
  const runPreflight = (args) => validateToolArguments(runtimeTool, {
    id: 'strict-preflight', name: 'ask_user', arguments: runtimeTool.prepareArguments(args),
  });
  const valid = { questions: [single({ required: false })] };
  assert.equal(tool.prepareArguments(valid), valid, 'validation must return the untouched object');
  assert.deepEqual(runPreflight(valid), valid);
  const missingKind = single(); delete missingKind.kind;
  const missingId = single(); delete missingId.id;
  const missingLabel = single({ options: [{ value: 'a' }, options[1]] });
  const derivedValue = single({ options: [{ label: 'A' }, options[1]] });
  assert.equal(tool.prepareArguments({ questions: [derivedValue] }).questions[0].options[0].value, undefined,
    'an omitted value stays omitted until normalization');
  for (const args of [
    { questions: [missingKind] }, { questions: [missingId] }, { questions: [missingLabel] },
    { questions: [single({ required: 'false' })] }, { questions: [single({ required: null })] },
    { questions: [single({ allowCustom: 'true' })] },
    { questions: [single()], description: 'Removed' },
    { questions: [{ id: 't', prompt: 'Text', kind: 'text', options: [] }] },
  ]) {
    const before = structuredClone(args);
    assert.throws(() => runPreflight(args), /Invalid ask_user arguments/);
    assert.deepEqual(args, before, 'invalid arguments cannot be repaired or normalized');
  }
});

test('strict input: direct execution rejects malformed arguments without opening UI', async () => {
  for (const args of [null, {}, { questions: [single()], description: undefined },
    { questions: [{ id: 't', prompt: 'Text', kind: 'text', allowCustom: false }] },
    { questions: [single({ options: [] })] },
    { questions: [single({ kind: 'multi', options: [{ value: 'a', label: 'A', preview: 'invalid' }, options[1]] })] },
  ]) {
    let opened = false;
    const result = await tool.execute('strict-invalid', args, undefined, undefined, {
      mode: 'tui', hasUI: true, ui: { custom() { opened = true; } },
    });
    assert.equal(opened, false);
    assert.equal(result.isError, true);
    assert.match(result.details.error, /Invalid ask_user arguments/);
    assert.deepEqual(result.details.questions, []);
    assert.ok(!('description' in result.details));
  }
});

test('baseline: render lines obey tested widths and contain no embedded newlines', async () => {
  const s = start([single({ prompt: '中文 prompt\nsecond line', options: [
    { value: 'a', label: '中文内容', description: 'line1\nline2', preview: '```ts\nconst a = 1;\n```' },
    options[1],
  ] })]);
  try {
    for (const width of [4, 10, 20, 40, 80, 120]) {
      for (const line of s.lines(width)) {
        assert.ok(!line.includes('\n'));
        assert.ok(visibleWidth(line) <= width, `width=${width}, line=${JSON.stringify(line)}`);
      }
    }
  } finally { await s.cancel(); }
});

// Regression coverage for interaction, focus, and terminal layout.

test('review: abort signal should settle an open custom question', async () => {
  const s = start([single()]);
  try {
    s.controller.abort();
    await nextTurn();
    assert.equal(s.settled, true, 'execute remains pending after AbortController.abort()');
  } finally { await s.cancel(); }
});

test('abort: already-cancelled calls never open a custom UI', async () => {
  const controller = new AbortController();
  controller.abort();
  let opened = false;
  const result = await tool.execute('pre-aborted', { questions: [single()] }, controller.signal, undefined, {
    mode: 'tui', hasUI: true, ui: { custom() { opened = true; } },
  });
  assert.equal(opened, false);
  assert.equal(result.details.cancelled, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('abort: active input closes and unregisters its listener', async () => {
  const s = start([{ id: 'text', prompt: 'Write a note', kind: 'text' }]);
  s.send(key.enter, 'draft');
  assert.equal(getEventListeners(s.controller.signal, 'abort').length, 1);
  s.controller.abort();
  const result = await s.promise;
  assert.equal(result.details.cancelled, true);
  assert.equal(s.doneCalls, 1);
  assert.equal(getEventListeners(s.controller.signal, 'abort').length, 0);
  s.send(key.enter, key.esc);
  s.component.dispose();
  assert.equal(s.doneCalls, 1);
});


test('disposal: disposing an unfinished component cancels exactly once', async () => {
  const s = start([single()]);
  s.component.dispose();
  s.component.dispose();
  const result = await s.promise;
  assert.equal(result.details.cancelled, true);
  assert.equal(s.doneCalls, 1);
  assert.equal(getEventListeners(s.controller.signal, 'abort').length, 0);
});

test('abort: cancellation between the precheck and factory is handled', async () => {
  const controller = new AbortController();
  const terminal = { columns: 80, rows: 24, write() {} };
  const tui = new TuiMainScreen(terminal, false);
  tui.requestRender = () => {};
  const result = await tool.execute('abort-race', { questions: [single()] }, controller.signal, undefined, {
    mode: 'tui', hasUI: true, ui: { custom(factory) {
      controller.abort();
      return new Promise((resolve) => factory(tui, theme, kb, resolve));
    } },
  });
  assert.equal(result.details.cancelled, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('review: focused free-text editor should emit its IME cursor marker', async () => {
  const s = start([{ id: 'text', prompt: 'Input Chinese', kind: 'text' }]);
  try {
    s.send(key.enter, '中文');
    assert.ok(s.lines().some((line) => line.includes(CURSOR_MARKER)), 'focused wrapper does not forward focus to Editor');
  } finally { await s.cancel(); }
});

test('default focus: explicit tab navigation preserves the next question default', async () => {
  const s = start([single({ id: 'first' }), single({ id: 'second', defaultValue: 'b' })]);
  s.send(key.enter); // confirming the first answer lands on the next question
  assert.match(s.plain().find((line) => line.startsWith('> ')), /Beta/);
  s.send(key.enter, key.enter); // confirm the last answer, then submit from the review page
  const result = await s.promise;
  assert.equal(result.details.answers.find((answer) => answer.id === 'second').value, 'b');
});

test('default focus: revisiting an answered question preserves its cursor', async () => {
  const s = start([single({ id: 'first' }), single({ id: 'second', defaultValue: 'b' })]);
  try {
    s.send(key.down, key.enter, key.right, key.right, key.right);
    assert.match(s.plain().find((line) => line.startsWith('> ')), /Beta/);
  } finally { await s.cancel(); }
});

test('editor focus: losing and regaining focus invalidates the cursor marker', async () => {
  const s = start([{ id: 'text', prompt: 'Write a note', kind: 'text' }]);
  try {
    s.send(key.enter, 'note');
    assert.ok(s.lines().some((line) => line.includes(CURSOR_MARKER)));
    s.component.focused = false;
    assert.ok(s.lines().every((line) => !line.includes(CURSOR_MARKER)));
    s.component.focused = true;
    assert.ok(s.lines().some((line) => line.includes(CURSOR_MARKER)));
    s.send(key.esc);
    assert.ok(s.lines().every((line) => !line.includes(CURSOR_MARKER)));
    assert.equal(s.settled, false);
  } finally { await s.cancel(); }
});

test('editor focus: custom single-choice input also emits the marker', async () => {
  const s = start([single({ allowCustom: true })]);
  try {
    s.send(key.down, key.down, key.enter, 'custom');
    assert.ok(s.lines().some((line) => line.includes(CURSOR_MARKER)));
  } finally { await s.cancel(); }
});

test('review: active option should remain visible in a 24-row preview question', async () => {
  const s = start([single({ allowCustom: true, options: Array.from({ length: 5 }, (_, i) => ({
    value: `value-${i}`, label: `Choice ${i}`, description: `Description ${i}`,
    preview: i === 0 ? Array.from({ length: 15 }, (_, n) => `preview ${n + 1}`).join('\n') : undefined,
  })) })]);
  try {
    const lines = s.plain();
    const selectedIndex = lines.findIndex((line) => line.startsWith('> '));
    assert.ok(selectedIndex >= 0);
    assert.ok(lines.slice(-24).some((line) => line.startsWith('> ')), 'focused choice is above the visible terminal viewport');
  } finally { await s.cancel(); }
});

test('review: valid option labels should have a path to read their distinguishing suffix', async () => {
  const s = start([single({ options: [
    { value: 'a', label: `${'共有前缀'.repeat(10)}仅本地` },
    { value: 'b', label: `${'共有前缀'.repeat(10)}公开发布` },
  ] })], { columns: 40 });
  try {
    const first = s.plain().join('\n');
    s.send(key.down);
    const second = s.plain().join('\n');
    assert.ok(first.includes('仅本地') && second.includes('公开发布'), 'choice differences are discarded by truncation, even when focused');
  } finally { await s.cancel(); }
});

test('layout: vertical resize and narrow widths keep the active option visible', async () => {
  const s = start([single({ allowCustom: true, options: Array.from({ length: 5 }, (_, i) => ({
    value: `v${i}`, label: `Option ${i} ${'中文'.repeat(12)}`, description: 'Details '.repeat(20),
  })) })]);
  try {
    for (const rows of [48, 24, 12, 8, 6, 5, 4]) {
      s.terminal.rows = rows;
      for (const width of [4, 10, 20, 40, 80, 120]) {
        s.terminal.columns = width;
        for (let i = 0; i < 10; i++) {
          const lines = s.lines();
          assert.ok(lines.length <= getInlineMaxHeight(rows), `rows=${rows} width=${width}`);
          assert.ok(lines.every((line) => !line.includes('\n') && visibleWidth(line) <= width));
          assert.ok(s.plain().some((line) => line.includes('> ')), `active choice or toolbar control missing: rows=${rows} width=${width}`);
          s.send(key.down);
        }
        for (let i = 0; i < 10; i++) s.send(key.up);
      }
    }
  } finally { await s.cancel(); }
});

test('layout: wrapped labels taller than the viewport can be read by paging', async () => {
  const s = start([single({ options: [
    { value: 'a', label: `${'Long '.repeat(16)}DISTINCT_END` }, options[1],
  ] })], { columns: 12, rows: 10 });
  try {
    let seen = '';
    for (let i = 0; i < 35; i++) {
      seen += s.plain().join('');
      s.send(key.pageDown);
    }
    assert.ok(seen.replace(/\s/g, '').includes('DISTINCT_END'));
    s.send(key.up);
    assert.ok(s.plain().some((line) => line.startsWith('> ')), 'navigation should return the viewport to the active option');
  } finally { await s.cancel(); }
});

test('layout: long prompts and preview excerpts remain reachable with paging', async () => {
  const s = start([single({ prompt: `PROMPT_START\n${'Extra context\n'.repeat(35)}`, options: [
    { value: 'a', label: 'Alpha', preview: Array.from({ length: 15 }, (_, i) => `PREVIEW_${i}`).join('\n') }, options[1],
  ] })], { columns: 40, rows: 12 });
  try {
    assert.ok(s.plain().some((line) => line.startsWith('> ')));
    for (let i = 0; i < 50; i++) { s.send(key.pageUp); s.lines(); }
    assert.match(s.plain().join('\n'), /PROMPT_START/);
    assert.doesNotMatch(s.plain().join('\n'), /PREVIEW_0/);
    s.send('\x0f'); // Expand the current option without navigating through other choices.
    assert.match(focusedLabel(s), /Alpha/);
    let seen = '';
    for (let i = 0; i < 70; i++) { seen += s.plain().join('\n'); s.send(key.pageDown); }
    assert.match(seen, /PREVIEW_0/);
    assert.match(seen, /Alt\+↑↓/);
    s.send(key.down);
    assert.ok(s.plain().some((line) => line.includes('> ')));
  } finally { await s.cancel(); }
});

test('layout: the input cursor stays inside short viewports after resize', async () => {
  const s = start([{ id: 'text', prompt: 'Context '.repeat(100), kind: 'text' }]);
  try {
    s.send(key.enter, '中文 and text '.repeat(50));
    for (const rows of [24, 12, 8]) {
      s.terminal.rows = rows;
      for (const width of [8, 20, 80]) {
        s.terminal.columns = width;
        const lines = s.lines();
        assert.ok(lines.length <= Math.max(1, rows - 2));
        assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)));
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
      }
    }
  } finally { await s.cancel(); }
});

test('layout: submit summaries can be paged without changing answers', async () => {
  const s = start([
    { id: 'one', prompt: 'First', kind: 'text' },
    { id: 'two', prompt: 'Second', kind: 'text' },
  ], { columns: 30, rows: 12 });
  s.send(key.enter, 'a'.repeat(120), key.enter); // save, next question
  s.send(key.enter, `${'b'.repeat(120)} SUMMARY_END`, key.enter); // save, land on Review
  let seen = '';
  for (let i = 0; i < 40; i++) { seen += s.plain().join(''); s.send(key.pageDown); }
  assert.ok(seen.replace(/\s/g, '').includes('SUMMARY_END'));
  s.send(key.enter);
  const result = await s.promise;
  assert.equal(result.details.answers.length, 2);
});

test('layout: invalidation refreshes cached output without losing editor focus', async () => {
  const s = start([{ id: 'text', prompt: 'Note', kind: 'text' }]);
  try {
    s.send(key.enter, '中文');
    const first = s.lines();
    assert.equal(s.lines(), first);
    s.component.invalidate();
    const second = s.lines();
    assert.notEqual(second, first);
    assert.ok(second.some((line) => line.includes(CURSOR_MARKER)));
  } finally { await s.cancel(); }
});

for (const kind of ['text', 'single', 'multi']) {
  for (const required of [true, false]) {
    test(`skip: ${required ? 'required' : 'optional'} ${kind} clears only its answer, not its note`, async () => {
      const question = kind === 'text'
        ? { id: 'q', kind, prompt: 'Explain', required }
        : single({ kind, required, defaultValue: 'b' });
      // Skip stays local only in multi-question flows, which is what this asserts.
      const s = start([question, single({ id: 'second', label: 'Second', required: false })]);
      try {
        activate(s, 'Add note');
        s.send('Please leave this open.', key.enter);
        activate(s, 'Skip');
        assert.equal(s.doneCalls, 0, 'Skip is not cancellation or automatic submission');
        review(s);
        s.send(key.enter);
        const result = await s.promise;
        assert.equal(result.details.cancelled, false);
        assert.deepEqual(result.details.answers, []);
        assert.deepEqual(result.details.skippedIds, ['q']);
        assert.deepEqual(result.details.notes, { q: 'Please leave this open.' });
        assert.deepEqual(result.details.unresolvedRequiredIds, required ? ['q'] : []);
        assert.match(result.content[0].text, /Please leave this open/);
        if (required) {
          assert.match(result.content[0].text, /unresolvedRequiredIds=\["q"\]/);
          assert.match(result.content[0].text, /not approval/);
          assert.doesNotMatch(result.content[0].text, /You can continue/);
        }
      } finally { await s.cancel(); }
    });
  }
}


test('notes: replacing a skip with an answer preserves notes and other questions', async () => {
  const s = start([
    single({ id: 'first' }),
    single({ id: 'second', kind: 'multi', defaultValue: 'b' }),
  ]);
  try {
    activate(s, 'Add note');
    s.send('first context', key.enter);
    activate(s, 'Alpha'); // Confirming advances to the second question.
    s.send(key.left);
    activate(s, 'Skip');
    s.send(key.right); // Next tab
    s.send(key.space); // Add Alpha to the second question's preselected Beta.
    activate(s, 'Add note');
    s.send('second context', key.enter);
    s.send(key.left);
    assert.match(focusedLabel(s), /Alpha/);
    assert.match(s.plain().join('\n'), /已跳过 · 仍待确认/);
    activate(s, 'Beta'); // Confirming advances again; review follows from here.
    review(s);
    s.send(key.enter);
    const result = await s.promise;
    assert.deepEqual(result.details.notes, { first: 'first context', second: 'second context' });
    assert.equal(result.details.answers.find((answer) => answer.id === 'first').value, 'b');
    assert.deepEqual(result.details.answers.find((answer) => answer.id === 'second').values, ['a', 'b']);
    assert.deepEqual(result.details.skippedIds, []);
    assert.deepEqual(result.details.unresolvedRequiredIds, []);
  } finally { await s.cancel(); }
});


test('notes: prototype-like question IDs serialize as own data without phantom notes', async () => {
  const s = start(['__proto__', 'constructor', 'toString'].map((id) => single({ id, required: false })));
  try {
    activate(s, 'Add note');
    s.send('prototype context', key.enter, key.right);
    activate(s, 'Beta'); // Confirming advances to the third question.
    activate(s, 'Add note');
    s.send('string context', key.enter);
    review(s);
    s.send(key.enter);
    const result = await s.promise;
    assert.equal(Object.getPrototypeOf(result.details.notes), Object.prototype);
    assert.ok(Object.hasOwn(result.details.notes, '__proto__'));
    assert.equal(result.details.notes.__proto__, 'prototype context');
    assert.equal(result.details.notes.toString, 'string context');
    assert.equal(Object.hasOwn(result.details.notes, 'constructor'), false);
    const rendered = tool.renderResult(result, { expanded: true, isPartial: false }, theme).render(80).map(stripTerminalSequences).join('\n');
    assert.match(rendered, /prototype context/);
    assert.match(rendered, /string context/);
    assert.doesNotMatch(rendered, /function Object/);
  } finally { await s.cancel(); }
});



test('notes: editor cursor survives short/narrow resizing and disappears after saving', async () => {
  const s = start([single()]);
  try {
    activate(s, 'Add note');
    const value = `NOTE_START ${'中文 context '.repeat(35)}NOTE_END`;
    s.send(value);
    for (const rows of [24, 12, 8]) {
      s.terminal.rows = rows;
      for (const width of [8, 20, 80]) {
        s.terminal.columns = width;
        const lines = s.lines();
        assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)));
        assert.ok(lines.length <= rows - 2);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
      }
    }
    s.send(key.enter);
    assert.ok(s.lines().every((line) => !line.includes(CURSOR_MARKER)));
    s.controller.abort();
    const result = await s.promise;
    assert.equal(result.details.cancelled, true);
    assert.equal(result.details.notes.q, value);
    assert.equal(getEventListeners(s.controller.signal, 'abort').length, 0);
  } finally { await s.cancel(); }
});



test('inline previews: expansion is question-local and descriptions are always visible', async () => {
  const s = start([
    single({ id: 'first', description: 'FIRST_DESCRIPTION', options: [{ value: 'a', label: 'Alpha', preview: 'FIRST_PREVIEW' }, options[1]] }),
    single({ id: 'second', description: 'SECOND_DESCRIPTION', options: [{ value: 'a', label: 'Alpha', preview: 'SECOND_PREVIEW' }, options[1]] }),
  ]);
  try {
    assert.match(s.plain().join('\n'), /FIRST_DESCRIPTION/);
    assert.doesNotMatch(s.plain().join('\n'), /FIRST_PREVIEW/);
    s.send(key.preview);
    assert.match(s.plain().join('\n'), /FIRST_PREVIEW/);
    s.send(key.right);
    assert.match(s.plain().join('\n'), /SECOND_DESCRIPTION/);
    assert.doesNotMatch(s.plain().join('\n'), /FIRST_PREVIEW|SECOND_PREVIEW/);
    s.send(key.preview);
    assert.match(s.plain().join('\n'), /SECOND_PREVIEW/);
    s.send(key.left);
    assert.match(s.plain().join('\n'), /FIRST_PREVIEW/);
    assert.doesNotMatch(s.plain().join('\n'), /SECOND_PREVIEW/);
    s.send(key.preview, key.right);
    assert.match(s.plain().join('\n'), /SECOND_PREVIEW/);
    s.controller.abort();
    const result = await s.promise;
    assert.deepEqual(result.details.answers, []);
    assert.deepEqual(result.details.skippedIds, []);
    assert.deepEqual(result.details.unresolvedRequiredIds, ['first', 'second']);
  } finally { await s.cancel(); }
});


test('preview cache: invalidated rendering retains normalized option identity', async () => {
  const { createQuestionnaire } = await import('../src/component.ts');
  const { PreviewLayoutCache } = await import('../src/preview.ts');
  const { normalizeQuestions } = await import('../src/schema.ts');
  const questions = normalizeQuestions({ questions: [single({ options: [
    { value: 'a', label: 'Alpha', preview: '字'.repeat(40000) }, options[1],
  ] })] });
  const tui = new TuiMainScreen({ columns: 80, rows: 24, write() {} }, false);
  tui.requestRender = () => {};
  const calls = [];
  const get = PreviewLayoutCache.prototype.get;
  PreviewLayoutCache.prototype.get = function (option, ...args) {
    calls.push(option);
    return get.call(this, option, ...args);
  };
  let component;
  try {
    component = createQuestionnaire(tui, theme, kb, { title: 'Test', questions }, () => {});
    component.handleInput(key.preview);
    component.render(80);
    component.invalidate();
    component.render(80);
    assert.equal(calls.length, 2, 'both real renders must reach preview layout');
    assert.ok(calls[0] === questions[0].options[0], 'cache key must be the stable normalized option');
    assert.ok(calls[1] === calls[0], 'invalidating a frame must not recreate the cache key');
  } finally {
    PreviewLayoutCache.prototype.get = get;
    component?.dispose();
  }
});


test('fixes: an explicitly skipped required multi-select can advance with Enter', async () => {
  const s = start([
    { id: 'pick', label: 'Pick', prompt: 'Choose any', kind: 'multi', options },
    single({ id: 'next', label: 'Next' }),
  ]);
  try {
    s.send(key.enter); // Nothing selected yet: still blocked.
    assert.match(s.plain().join('\n'), /请先选择一项/);
    s.send(key.skip);
    assert.match(s.plain().join('\n'), /已跳过 · 仍待确认/);
    s.send(key.enter);
    assert.match(focusedLabel(s), /Alpha/, 'Enter must advance once the question was explicitly skipped');
    assert.doesNotMatch(s.plain().join('\n'), /请先选择一项/);
    s.send(key.enter);
    review(s);
    s.send(key.enter);
    const result = await s.promise;
    assert.deepEqual(result.details.answers.map((answer) => answer.id), ['next']);
    assert.deepEqual(result.details.skippedIds, ['pick']);
    assert.deepEqual(result.details.unresolvedRequiredIds, ['pick']);
    assert.equal(result.details.cancelled, false);
  } finally { await s.cancel(); }
});

test('fixes: re-confirming a seeded default keeps its provenance', async () => {
  const s = start([single({ defaultValue: 'b' }), { id: 'm', label: 'Multi', prompt: 'Pick any', kind: 'multi', options, defaultValue: 'a' }]);
  try {
    assert.match(s.plain().join('\n'), /（默认）/);
    s.send(key.enter); // Confirm the default single answer.
    assert.match(s.plain().join('\n'), /（默认）/, 'the default marker must survive confirmation');
    s.send(key.enter); // Finish the multi-select with its seeded default.
    review(s);
    s.send(key.enter);
    const result = await s.promise;
    assert.deepEqual(result.details.answers.map((answer) => answer.value ?? answer.values), ['b', ['a']]);
    assert.ok(result.details.answers.every((answer) => answer.wasDefault === true));
  } finally { await s.cancel(); }
});




test('fixes: kitty CSI-u letters and Shift+F6 keep their documented meaning', async () => {
  setKittyProtocolActive(true);
  try {
    const s = start([single(), single({ id: 'other', defaultValue: 'a' })]);
    try {
      s.send('\x1b[106u'); // j
      assert.match(focusedLabel(s), /Beta/);
      s.send('\x1b[107u'); // k
      assert.match(focusedLabel(s), /Alpha/);
      s.send('\x1b[17;2u'); // Kitty-style Shift+F6 reverses straight to Skip.
      assert.ok(auxiliaryIsFocused(s, '跳过'));
      s.send('\x1b[27;2;17~'); // xterm modifyOtherKeys spelling: Skip -> note.
      assert.ok(auxiliaryIsFocused(s, '附加说明'));
      s.send('\x1b[27;2;17~'); // note -> answers.
      assert.match(focusedLabel(s), /Alpha/);
    } finally { await s.cancel(); }
  } finally { setKittyProtocolActive(false); }

  const t = start([{ id: 'text', prompt: 'Type something', kind: 'text' }]);
  try {
    t.send('\x1b[17;2u'); // Shift+F6 must not leak into the free-text editor.
    assert.match(t.plain().join('\n'), /附加说明/);
    assert.ok(!t.lines().some((line) => line.includes(CURSOR_MARKER)));
    t.send(key.up); // Back to answers.
    t.send('\x1b[H'); // Home is a key press, not typed text.
    assert.ok(!t.lines().some((line) => line.includes(CURSOR_MARKER)), 'stray escape sequences must not start an editor');
    t.send('x'); // Typing still opens the free-text editor.
    assert.ok(t.lines().some((line) => line.includes(CURSOR_MARKER)));
  } finally { await t.cancel(); }
});

test('fixes: resizing while an auxiliary control is focused keeps the reading position', async () => {
  const s = start([single({ prompt: Array.from({ length: 40 }, (_, i) => `LINE_${i}`).join('\n') })], { columns: 40, rows: 12 });
  try {
    s.plain();
    s.send(key.pageDown);
    const before = s.plain().join('\n');
    assert.match(before, /Alpha/, 'paging must reach the answer list before resizing');
    assert.doesNotMatch(before, /LINE_0/, 'paging must scroll away from the prompt start');
    s.send(key.actions);
    s.terminal.rows = 14;
    const after = s.plain().join('\n');
    assert.doesNotMatch(after, /LINE_0/, 'auxiliary focus must not snap the viewport back to the top');
    assert.match(after, /Alpha/);
    s.terminal.rows = 16;
    assert.doesNotMatch(s.plain().join('\n'), /LINE_0/);
  } finally { await s.cancel(); }
});

test('fixes: transcript rendering sanitizes caller text and tolerates host error details', () => {
  const render = (text) => text.render(80).join('\n');
  const renderPlain = (text) => stripTerminalSequences(render(text));
  const call = render(tool.renderCall({ title: '\x1b[31mALERT\x1b]8;;http://x\x07link\x1b]8;;\x07', questions: [options] }, theme));
  assert.ok(!call.includes('\x1b[31m'), 'caller ANSI must not reach the transcript');
  assert.ok(!call.includes('\x1b]8;'), 'caller OSC must not reach the transcript');
  assert.match(stripTerminalSequences(call), /ALERT/);
  assert.match(call, /（1题）/);

  const counted = render(tool.renderCall({ title: '21 questions', questions: [options] }, theme));
  assert.match(counted, /（1题）/, 'a numeric suffix from another count must not suppress the real one');
  const already = render(tool.renderCall({ title: 'Scope（2题）', questions: [options, options] }, theme));
  assert.doesNotMatch(already, /（2题）（2题）/);

  const hostError = renderPlain(tool.renderResult({ content: [{ type: 'text', text: 'Error: bad input' }], details: {} }, { expanded: true, isPartial: false }, theme));
  assert.match(hostError, /Error: bad input/);

  const cancelled = renderPlain(tool.renderResult({
    content: [{ type: 'text', text: 'User cancelled the questions' }],
    details: { title: 'T', questions: [{ id: 'q', label: '决定', kind: 'single', required: true }], answers: [], cancelled: true, unresolvedRequiredIds: ['q'] },
  }, { expanded: true, isPartial: false }, theme));
  assert.match(cancelled, /已取消/);
  assert.match(cancelled, /待确认：q/);

  const noteText = tool.renderResult({
    content: [{ type: 'text', text: 'ok' }],
    details: {
      title: 'T', questions: [{ id: 'q', label: '\x1b[31m决定', kind: 'single', required: true }],
      answers: [{ id: 'q', kind: 'single', value: 'a', label: 'Alpha' }], cancelled: false,
      notes: { q: 'line one\nline two \x1b]0;pwn\x07' },
    },
  }, { expanded: true, isPartial: false }, theme);
  const note = render(noteText);
  assert.ok(!note.includes('\x1b[31m') && !note.includes('\x1b]0;'), 'labels and notes must be sanitized');
  assert.match(renderPlain(noteText), /决定: Alpha/);
  assert.match(renderPlain(noteText), /line two/);
});

test('fixes: changing a seeded multi-select clears its default provenance', async () => {
  const s = start([
    { id: 'm', label: 'Multi', prompt: 'Pick any', kind: 'multi', options, defaultValue: 'a' },
    single({ id: 'second', label: 'Second', required: false }),
  ]);
  try {
    s.send(key.down, key.space);
    s.send(key.enter);
    s.send(key.enter);
    review(s);
    s.send(key.enter);
    const result = await s.promise;
    assert.deepEqual(result.details.answers[0].values, ['a', 'b']);
    assert.equal(result.details.answers[0].wasDefault, undefined);
  } finally { await s.cancel(); }
});

test('fixes: direct shortcuts do not leave a stale auxiliary focus', async () => {
  const s = start([single({ defaultValue: 'b' }), single({ id: 'second', label: 'Second', required: false })]);
  try {
    s.send(key.actions, key.actions); // Focus Skip.
    assert.ok(auxiliaryIsFocused(s, '跳过'));
    s.send(key.note, 'note from shortcut', key.enter);
    assert.match(focusedLabel(s), /Beta/, 'Ctrl+N returns focus to the answers instead of leaving Skip armed');
    s.send(key.enter);
    s.send(key.enter);
    review(s);
    s.send(key.enter);
    const result = await s.promise;
    assert.deepEqual(result.details.skippedIds, [], 'a following Enter must not replay the stale Skip');
    assert.deepEqual(result.details.notes, { q: 'note from shortcut' });
    assert.equal(result.details.answers[0].value, 'b');
  } finally { await s.cancel(); }
});

test('fixes: Ctrl+S drops the auxiliary focus it was invoked over', async () => {
  const s = start([single({ defaultValue: 'b' }), single({ id: 'second', label: 'Second', required: false })]);
  try {
    s.send(key.actions); // Focus the note control.
    s.send(key.skip);
    assert.match(s.plain().join('\n'), /已跳过/);
    assert.match(focusedLabel(s), /Alpha/, 'focus returns to the answers after a direct skip');
    assert.equal(auxiliaryIsFocused(s, '跳过'), false);
    s.send(key.enter);
    s.send(key.enter);
    review(s);
    s.send(key.enter);
    const result = await s.promise;
    assert.equal(result.details.answers[0].value, 'a');
    assert.deepEqual(result.details.skippedIds, [], 'answering after Skip clears it');
  } finally { await s.cancel(); }
});

test('focus: Tab walks every answer option before reaching the auxiliary controls', async () => {
  const s = start([single({ defaultValue: 'b', prompt: 'FIRST_QUESTION' }), single({ id: 'other', defaultValue: 'a', prompt: 'SECOND_QUESTION' })]);
  try {
    assert.match(focusedLabel(s), /Beta/, 'the seeded default is the starting focus');
    s.send(key.tab);
    assert.ok(auxiliaryIsFocused(s, '附加说明'), 'the last option is followed by the note control');
    s.send(key.tab);
    assert.ok(auxiliaryIsFocused(s, '跳过'));
    s.send(key.tab);
    assert.match(focusedLabel(s), /Alpha/, 'the ring wraps back to the first option');
    assert.equal(auxiliaryIsFocused(s, '跳过'), false);
    s.send(key.tab);
    assert.match(focusedLabel(s), /Beta/, 'Tab also moves between options');
    s.send(key.shiftTab);
    assert.match(focusedLabel(s), /Alpha/, 'Shift+Tab walks backwards');
    s.send(key.shiftTab);
    assert.ok(auxiliaryIsFocused(s, '跳过'), 'wrapping backwards lands on the last ring entry');
    s.send(key.shiftTab);
    assert.ok(auxiliaryIsFocused(s, '附加说明'));
    s.send(key.actions); // F6 still jumps straight into the auxiliary row.
    assert.ok(auxiliaryIsFocused(s, '跳过'));
    s.send(key.down); // Arrows return to the answers without changing the option.
    assert.match(focusedLabel(s), /Alpha/);
    for (let i = 0; i < 4; i++) s.send(key.tab);
    assert.match(s.plain().join('\n'), /FIRST_QUESTION/, 'Tab never changes the question');
    s.send(key.right);
    assert.match(focusedLabel(s), /Alpha/, '←/→ are the only question navigation');
  } finally { await s.cancel(); }
});

test('single-question flows offer no Skip at all', async () => {
  const s = start([single({ defaultValue: 'b' })]);
  try {
    const row = s.plain().find((line) => /\[(?:附加说明|说明)/.test(line)) || '';
    assert.match(row, /附加说明/);
    assert.doesNotMatch(row, /跳过/, 'a single question has no later question a skip could apply to');
    s.send(key.tab);
    assert.ok(auxiliaryIsFocused(s, '附加说明'), 'the last option is followed by the note control');
    s.send(key.tab);
    assert.match(focusedLabel(s), /Alpha/, 'the ring wraps back to the first option');
    s.send(key.previousAction);
    assert.ok(auxiliaryIsFocused(s, '附加说明'), 'reverse cycling has only the note control left');
    s.send(key.previousAction);
    assert.match(focusedLabel(s), /Alpha/);
    s.send(key.skip); // Ctrl+S is inert: there is nothing to skip to.
    assert.equal(s.settled, false, 'Ctrl+S must not decide a single-question flow');
    assert.match(focusedLabel(s), /Alpha/);
    s.send(key.down); // Move back to the seeded default, then submit it.
    assert.match(focusedLabel(s), /Beta/);
    s.send(key.enter);
    const result = await s.promise;
    assert.deepEqual(result.details.answers[0].value, 'b');
    assert.deepEqual(result.details.skippedIds, []);
    assert.deepEqual(result.details.unresolvedRequiredIds, []);
  } finally { await s.cancel(); }
});

test('single-question required multi-selects cannot be skipped out of', async () => {
  const s = start([{ id: 'm', prompt: 'Pick any', kind: 'multi', options, required: true }]);
  try {
    s.send(key.enter);
    assert.match(s.plain().join('\n'), /请先选择一项。/);
    assert.doesNotMatch(s.plain().join('\n'), /Ctrl\+S 跳过/);
    s.send(key.skip);
    assert.equal(s.settled, false);
    s.send(key.down, key.space, key.enter);
    const result = await s.promise;
    assert.deepEqual(result.details.answers[0].values, ['b']);
    assert.deepEqual(result.details.skippedIds, []);
  } finally { await s.cancel(); }
});

test('multi custom values: saving lands on the new value instead of an empty editor', async () => {
  const s = start([
    { id: 'pick', label: 'Pick', prompt: 'Pick any', kind: 'multi', options, allowCustom: true },
    single({ id: 'next', label: 'Next', required: false }),
  ]);
  try {
    s.send(key.down, key.down); // Alpha -> Beta -> 自定义回答
    assert.match(focusedLabel(s), /自定义回答/);
    s.send(key.enter, 'custom one', key.enter);
    assert.ok(!s.lines().some((line) => line.includes(CURSOR_MARKER)), 'saving must close the editor');
    assert.match(focusedLabel(s), /custom one/, 'focus moves to the value that was just created');
    s.send(key.enter); // Enter now finishes the multi-select instead of reopening the editor.
    assert.match(focusedLabel(s), /Alpha/, 'the flow advances to the next question');
    assert.ok(!s.lines().some((line) => line.includes(CURSOR_MARKER)));
    s.send(key.enter);
    review(s);
    s.send(key.enter);
    const result = await s.promise;
    assert.deepEqual(result.details.answers[0].values, ['custom one']);
    assert.equal(result.details.answers[0].wasCustom, true);
  } finally { await s.cancel(); }
});

test('preview: Tab moves focus back into the questionnaire instead of doing nothing', async () => {
  const s = start([
    single({ id: 'first', label: 'First', defaultValue: 'b' }),
    single({ id: 'second', label: 'Second', defaultValue: 'a' }),
  ], { rows: 16 });
  try {
    s.send(key.right, key.right);
    assert.match(s.plain().join('\n'), /回答预览/);
    assert.match(s.plain().join('\n'), /Tab 返回题目/);
    s.send(key.tab);
    assert.match(focusedLabel(s), /Beta/, 'Tab returns to the first question');
    s.send(key.right, key.right);
    assert.match(s.plain().join('\n'), /回答预览/);
    s.send(key.shiftTab);
    assert.match(focusedLabel(s), /Alpha/, 'Shift+Tab returns to the last question');
    s.send(key.right);
    assert.match(s.plain().join('\n'), /回答预览/);
    s.send(key.enter);
    const result = await s.promise;
    assert.deepEqual(result.details.answers.map((answer) => answer.value), ['b', 'a']);
  } finally { await s.cancel(); }
});

test('render: repeated measurement frames never select or refocus anything', async () => {
  const s = start([{ id: 'pick', prompt: 'Pick any', kind: 'multi', options, required: true }]);
  try {
    for (const [columns, rows] of [[80, 24], [40, 12], [20, 6], [10, 4], [80, 24]]) {
      s.terminal.columns = columns;
      s.terminal.rows = rows;
      s.lines();
      s.lines();
    }
    assert.equal(s.doneCalls, 0);
    s.send(key.enter); // Nothing was selected by any of those renders.
    assert.match(s.plain().join('\n'), /请先选择一项。/);
    s.send(key.space);
    const selected = (s.plain().join('\n').match(/\[x\]/g) || []).length;
    assert.equal(selected, 1, 'exactly the focused option is selected, with no phantom entries');
  } finally { await s.cancel(); }
});

test('keybindings: rebound host keys reach the questionnaire, defaults still work', async () => {
  const rebound = new KeybindingsManager({
    'tui.select.up': 'n',
    'tui.select.down': 'm',
    'tui.select.confirm': 'ctrl+y',
    'tui.select.cancel': 'ctrl+g',
  });
  const s = start([single({ defaultValue: 'b' })], { bindings: rebound });
  try {
    assert.match(focusedLabel(s), /Beta/);
    s.send('n'); // Rebound select.up.
    assert.match(focusedLabel(s), /Alpha/);
    s.send('m'); // Rebound select.down.
    assert.match(focusedLabel(s), /Beta/);
    s.send('\x19'); // ctrl+y, rebound select.confirm.
    const result = await s.promise;
    assert.equal(result.details.cancelled, false);
    assert.equal(result.details.answers[0].value, 'b');
  } finally { await s.cancel(); }

  const cancelled = start([single()], {
    bindings: new KeybindingsManager({ 'tui.select.cancel': 'ctrl+g' }),
  });
  cancelled.send('\x07'); // ctrl+g only; the default Esc must not be involved.
  const cancelledResult = await cancelled.promise;
  assert.equal(cancelledResult.details.cancelled, true);

  const defaults = start([single()]);
  defaults.send(key.up, key.down, key.enter);
  const defaultResult = await defaults.promise;
  assert.equal(defaultResult.details.answers[0].value, 'b', 'default arrow/enter bindings still work');
});

test('host failures: a rejected or empty custom() becomes a structured error', async () => {
  const params = { questions: [single()] };

  const rejecting = await tool.execute('reject-call', params, undefined, undefined, {
    mode: 'tui', hasUI: true, ui: { custom() { return Promise.reject(new Error('boom')); } },
  });
  assert.equal(rejecting.isError, true);
  assert.equal(rejecting.details.cancelled, false);
  assert.match(rejecting.content[0].text, /questionnaire UI failed: boom/);
  assert.deepEqual(rejecting.details.unresolvedRequiredIds, ['q']);

  const empty = await tool.execute('empty-call', params, undefined, undefined, {
    mode: 'tui', hasUI: true, ui: { custom() { return Promise.resolve(undefined); } },
  });
  assert.equal(empty.isError, true);
  assert.equal(empty.details.cancelled, false);
  assert.match(empty.content[0].text, /closed without a result/);

  // The host answers a thrown `execute` with `details: {}`; the renderer must survive it.
  const rendered = tool.renderResult(
    { content: [{ type: 'text', text: 'Error: boom' }], details: {} },
    { expanded: true, isPartial: false },
    theme,
  ).render(80).join('\n');
  assert.match(stripTerminalSequences(rendered), /Error: boom/);
});

test('options may omit value: the label becomes the returned value', async () => {
  const s = start([{ id: 'q', prompt: 'Pick one', kind: 'single', options: [{ label: 'Alpha' }, { label: 'Beta' }] }]);
  try {
    assert.match(s.plain().join('\n'), /Alpha/);
    s.send(key.down, key.enter);
    const result = await s.promise;
    assert.deepEqual(result.details.answers[0], { id: 'q', kind: 'single', value: 'Beta', label: 'Beta', wasCustom: false });
    assert.doesNotMatch(result.content[0].text, /undefined/);
  } finally { await s.cancel(); }

  const seeded = start([{ id: 'q', prompt: 'Pick one', kind: 'single', defaultValue: 'Beta', options: [{ label: 'Alpha' }, { label: 'Beta' }] }]);
  try {
    assert.match(focusedLabel(seeded), /Beta/, 'defaultValue matches an option by its label when value is omitted');
    seeded.send(key.enter);
    const result = await seeded.promise;
    assert.equal(result.details.answers[0].value, 'Beta');
    assert.equal(result.details.answers[0].wasDefault, true);
  } finally { await seeded.cancel(); }
});
