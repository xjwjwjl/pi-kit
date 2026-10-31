import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveInlineLayout } from '../src/inline-layout.ts';

// Internals are test oracles ONLY. Production uses the public component tree.
const sdk = new URL('../node_modules/@earendil-works/', import.meta.url);
const { Container } = await import(new URL('pi-tui/dist/index.js', sdk));
const { allocateStackSizes } = await import(new URL('pi-tui/dist/components/stack.js', sdk));
const { renderLayoutFrame } = await import(new URL('pi-tui/dist/layout.js', sdk));
const { createChatViewport } = await import(new URL('pi-coding-agent/dist/modes/interactive/chat-viewport.js', sdk));

function component(height = 0, label = 'sibling') {
  return { height, invalidate() {}, render() { return Array(this.height).fill(label); } };
}

function fixture({ rows = 24, mode = 'fullscreen', heights = [0, 1, 1, 0, 2], requested = 14 } = {}) {
  const owner = component(requested, 'owner');
  const editor = new Container();
  editor.addChild(owner);
  const siblings = heights.map((height, index) => component(height, `sibling-${index}`));
  const document = component(30, 'transcript');
  const children = [document, ...siblings.slice(0, 3), editor, ...siblings.slice(3)];
  const tui = { mode, terminal: { rows, columns: 80 }, children };
  const resolve = (width = 80, height = requested) => resolveInlineLayout(tui, owner, width, height);
  return { tui, owner, editor, siblings, document, resolve };
}

function viewport(f) {
  const [document, pendingMessages, status, widgetsAbove, editor, widgetsBelow, footer] = f.tui.children;
  return createChatViewport({ document, pendingMessages, status, widgetsAbove, editor, widgetsBelow, footer, scrollbar: 'hidden' });
}

function findBox(box, component) {
  if (box.component === component) return box;
  for (const child of box.children) {
    const found = findBox(child, component);
    if (found) return found;
  }
}

function assertBounded(result, requested, rows, { fullscreen = false } = {}) {
  assert.ok(Number.isInteger(result.height));
  assert.ok(result.height >= (fullscreen ? 0 : 1));
  assert.ok(result.height <= Math.min(requested, rows));
  assert.ok(Number.isInteger(result.naturalHeight));
  assert.ok(result.naturalHeight >= 1 && result.naturalHeight <= requested);
  assert.equal(typeof result.key, 'string');
}

test('standalone regular rendering is natural and bounded only by terminal rows', () => {
  for (const rows of [1, 2, 4, 8, 14, 24, 100]) {
    for (const requested of [1, 2, 3, 7, 14]) {
      const tui = { mode: 'regular', terminal: { rows }, children: [] };
      const result = resolveInlineLayout(tui, component(), 40, requested);
      assert.equal(result.height, Math.min(rows, requested));
      assert.equal(result.naturalHeight, result.height);
      assertBounded(result, requested, rows);
    }
  }
});

test('unknown or unmounted fullscreen trees fall back without rendering anything', () => {
  const owner = { render() { throw Error('must not render owner'); }, invalidate() {} };
  for (const rows of [1, 2, 4, 24]) {
    for (const children of [[], [owner], Array(7).fill(owner)]) {
      const result = resolveInlineLayout({ mode: 'fullscreen', terminal: { rows }, children }, owner, 40, 14);
      assert.equal(result.height, Math.min(rows, 3));
      assert.equal(result.naturalHeight, result.height);
      assert.match(result.key, /fallback:unknown-tree/);
    }
  }
  for (const mutate of [
    (f) => f.editor.clear(),
    (f) => f.editor.addChild(component(2)),
    (f) => { f.tui.children[4] = component(14); },
    (f) => { f.tui.children[6] = f.tui.children[5]; },
    (f) => { f.tui.children[2] = null; },
    (f) => { f.tui.children.push(component()); },
  ]) {
    const f = fixture();
    mutate(f);
    assert.match(f.resolve().key, /fallback:unknown-tree/);
  }
});

test('unknown mounted regular layouts also use a conservative fallback', () => {
  const owner = component();
  const tui = { mode: 'regular', terminal: { rows: 24 }, children: [component()] };
  const result = resolveInlineLayout(tui, owner, 80, 14);
  assert.equal(result.height, 3);
  assert.equal(result.naturalHeight, 3);
  assert.match(result.key, /fallback:unknown-tree/);
});

test('measurement never renders transcript, owner, or editor root and leaves the public tree untouched', () => {
  const f = fixture();
  const bomb = () => { throw Error('own root and transcript must not be measured'); };
  f.document.render = bomb;
  f.owner.render = bomb;
  f.editor.render = bomb;
  const children = [...f.tui.children];
  const editorChildren = [...f.editor.children];
  Object.freeze(f.tui.children);
  Object.freeze(f.editor.children);
  for (const sibling of f.siblings) Object.freeze(sibling);
  const result = f.resolve();
  assert.equal(result.height, 14);
  assert.equal(result.naturalHeight, 14);
  assert.deepEqual(f.tui.children, children);
  assert.deepEqual(f.editor.children, editorChildren);
});

test('regular mode reserves below-editor widgets and footer, not the scrolling document or preceding dock', () => {
  for (const rows of [1, 4, 8, 12, 24, 40]) {
    for (const below of [0, 1, 3, 8, 30]) {
      for (const footer of [0, 2, 10]) {
        const f = fixture({ mode: 'regular', rows, heights: [50, 50, 50, below, footer] });
        for (const root of [f.document, ...f.siblings.slice(0, 3)]) {
          root.render = () => { throw Error('regular scrollback is unconstrained'); };
        }
        const result = f.resolve();
        const expected = Math.min(14, Math.max(1, rows - below - footer));
        assert.equal(result.height, expected);
        assert.equal(result.naturalHeight, expected, 'regular output must not pad back to requested');
        assertBounded(result, 14, rows);
        if (below + footer >= rows) assert.match(result.key, /fallback:obstructed/);
      }
    }
  }
});

test('cache keys track dimensions, requested height, mode, and individual sibling heights', () => {
  const f = fixture({ rows: 50 });
  const initial = f.resolve();
  assert.equal(f.resolve().key, initial.key);
  assert.notEqual(f.resolve(79).key, initial.key);
  assert.notEqual(f.resolve(80, 13).key, initial.key);
  f.tui.terminal.rows++;
  assert.notEqual(f.resolve().key, initial.key);
  f.tui.terminal.rows--;
  for (const sibling of f.siblings) {
    sibling.height++;
    assert.notEqual(f.resolve().key, initial.key, 'unchanged visible height must still invalidate its key');
    sibling.height--;
  }
  f.tui.mode = 'regular';
  const regular = f.resolve();
  assert.notEqual(regular.key, initial.key);
  f.siblings[3].height++;
  assert.notEqual(f.resolve().key, regular.key);
  f.siblings[3].height--;
  f.siblings[4].height++;
  assert.notEqual(f.resolve().key, regular.key);
});

test('width-dependent widget measurements use the supplied width, not terminal columns', () => {
  const f = fixture({ rows: 20, heights: [0, 0, 0, 0, 0] });
  f.siblings[3].render = (width) => Array(Math.ceil(100 / width)).fill('wrapped');
  const wide = f.resolve(100);
  const narrow = f.resolve(10);
  assert.notEqual(wide.key, narrow.key);
  assert.ok(narrow.height < wide.height);
  f.tui.mode = 'regular';
  assert.equal(f.resolve(100).height, 14);
  assert.equal(f.resolve(10).height, 10);
});

test('sibling exceptions and invalid render results give bounded fallbacks, with guard cleanup', () => {
  for (const mode of ['fullscreen', 'regular']) {
    for (const render of [() => { throw Error('untrusted widget'); }, () => null, () => ({ length: Infinity })]) {
      const f = fixture({ mode });
      const original = f.siblings[4].render;
      f.siblings[4].render = render;
      const failed = f.resolve();
      assertBounded(failed, 14, 24);
      assert.ok(failed.height <= 3);
      assert.equal(failed.naturalHeight, failed.height);
      assert.match(failed.key, /fallback:(measurement-error|invalid-sibling)/);
      f.siblings[4].render = original;
      assert.doesNotMatch(f.resolve().key, /fallback/);
    }
  }
});

test('reentrant sibling rendering is bounded and taints the outer measurement, then recovers', () => {
  for (const mode of ['fullscreen', 'regular']) {
    const f = fixture({ mode });
    const sibling = f.siblings[4];
    const original = sibling.render;
    let calls = 0;
    let nested;
    sibling.render = () => {
      calls++;
      // Another owner still shares this root's measurement guard.
      nested = resolveInlineLayout(f.tui, component(), 80, 14);
      return Array(nested.naturalHeight).fill('recursive-widget');
    };
    const result = f.resolve();
    assert.equal(calls, 1);
    assert.match(nested.key, /fallback:reentrant/);
    assert.match(result.key, /fallback:sibling-cycle/);
    assert.ok(result.height <= 3);
    sibling.render = original;
    assert.doesNotMatch(f.resolve().key, /fallback/);
  }
});

test('measurement guards are scoped to the TUI, not global', () => {
  const a = fixture();
  const b = fixture();
  let nested;
  a.siblings[4].render = () => {
    nested = b.resolve();
    return ['footer'];
  };
  assert.doesNotMatch(a.resolve().key, /fallback/);
  assert.doesNotMatch(nested.key, /fallback/);
});

test('fullscreen minima are clipped by the physical dock viewport, including zero visible rows', () => {
  for (const [rows, expected] of [[1, 0], [2, 1], [3, 2], [4, 3]]) {
    const f = fixture({ rows, heights: [0, 0, 0, 0, 0] });
    const result = f.resolve();
    assert.equal(result.height, expected);
    assert.equal(result.naturalHeight, 14, 'do not feed shrinkage into the next natural measurement');
    const frame = renderLayoutFrame(viewport(f).root, 40, rows, () => {});
    assert.equal(findBox(frame.root, f.editor).clip.height, expected);
  }
});

test('fullscreen predictions match actual Pi 1.3.0 stack allocation and clipped layout frames', () => {
  const configurations = [
    [0, 0, 0, 0, 0], [0, 1, 1, 0, 2], [1, 1, 1, 1, 1],
    [3, 4, 5, 6, 2], [20, 0, 0, 0, 2], [0, 0, 0, 30, 4],
    [13, 2, 8, 7, 11], [40, 40, 40, 40, 40],
  ];
  let comparisons = 0;
  for (const rows of [1, 2, 3, 4, 5, 7, 8, 10, 12, 16, 24, 40]) {
    for (const width of [1, 20, 80]) {
      for (const requested of [1, 2, 3, 7, 10, 14]) {
        for (const heights of configurations) {
          const f = fixture({ rows, heights, requested });
          const result = f.resolve(width);
          const natural = [...heights.slice(0, 3), requested, ...heights.slice(3)];
          const entries = natural.map((_, index) => ({ shrink: 1, minSize: index === 3 ? 3 : 0 }));
          const intrinsic = allocateStackSizes(entries, natural, undefined, 0);
          const outer = allocateStackSizes([
            { basis: 0, grow: 1, shrink: 1, minSize: 1 },
            { basis: 'auto', grow: 0, shrink: 1, minSize: 1 },
          ], [0, intrinsic.reduce((a, b) => a + b, 0)], rows, 0);
          const dock = allocateStackSizes(entries, natural, outer[1], 0);
          const top = outer[0] + dock[0] + dock[1] + dock[2];
          const clipped = Math.max(0, Math.min(dock[3], Math.min(rows, outer[0] + outer[1]) - top));
          const context = JSON.stringify({ rows, width, requested, heights, outer, dock });
          assert.equal(result.height, Math.min(requested, clipped), context);
          assert.equal(result.naturalHeight, requested, context);
          assertBounded(result, requested, rows, { fullscreen: true });

          const frame = renderLayoutFrame(viewport(f).root, width, rows, () => {});
          const editorBox = findBox(frame.root, f.editor);
          assert.equal(editorBox.rect.height, dock[3], context);
          assert.equal(editorBox.clip.height, clipped, context);
          assert.equal(result.height, Math.min(requested, editorBox.clip.height), context);
          assert.equal(frame.lines.filter((line) => line.startsWith('owner'.slice(0, width))).length, result.height, context);
          comparisons++;
        }
      }
    }
  }
  assert.equal(comparisons, 1728);
});

test('padding the invisible fullscreen tail preserves layout across repeated host measurements', () => {
  const f = fixture({ rows: 12, requested: 14, heights: [3, 2, 1, 4, 2] });
  const keys = [];
  let visibleHeight;
  f.owner.render = (width) => {
    const result = f.resolve(width);
    keys.push(result.key);
    visibleHeight = result.height;
    return [...Array(result.height).fill('owner'), ...Array(result.naturalHeight - result.height).fill('')];
  };
  const root = viewport(f).root;
  for (let iteration = 0; iteration < 8; iteration++) {
    const frame = renderLayoutFrame(root, 40, 12, () => {});
    assert.equal(frame.lines.filter((line) => line.startsWith('owner')).length, visibleHeight);
    assert.equal(f.editor.render(40).length, 14);
  }
  assert.ok(keys.length >= 8);
  assert.equal(new Set(keys).size, 1);
});
