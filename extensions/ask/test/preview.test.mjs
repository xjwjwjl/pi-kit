import assert from 'node:assert/strict';
import test from 'node:test';
import { layoutPreview, MAX_PREVIEW_CHARACTERS, PreviewLayoutCache } from '../src/preview.ts';
import { visibleWidth } from '@earendil-works/pi-tui';

test('preview preserves code-fence styling without rendering fences', () => {
  const result = layoutPreview('Explanation\n```ts\nconst value = 1;\n```\nDone', 80, 15);
  assert.deepEqual(result, { lines: [
    { text: 'Explanation', code: false },
    { text: '  const value = 1;', code: true },
    { text: 'Done', code: false },
  ], truncated: false });
});

test('preview limits both wrapped output and source characters', () => {
  const result = layoutPreview('字'.repeat(400_000), 20, 15);
  assert.equal(result.lines.length, 15);
  assert.equal(result.truncated, true);
  assert.ok(result.lines.every((line) => visibleWidth(line.text) <= 20));
  const wide = layoutPreview('a'.repeat(MAX_PREVIEW_CHARACTERS + 200), 10_000, 15);
  assert.equal(wide.lines.map((line) => line.text).join('').length, MAX_PREVIEW_CHARACTERS);
  assert.equal(wide.truncated, true);
});

test('preview detects line overflow without reporting a fabricated exact count', () => {
  assert.equal(layoutPreview('one\ntwo', 80, 2).truncated, false);
  const result = layoutPreview('one\ntwo\nthree', 80, 2);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.lines.map((line) => line.text), ['one', 'two']);
  assert.deepEqual(layoutPreview('one', 80, 0), { lines: [], truncated: true });
});

test('preview does not leave half a surrogate pair at the excerpt boundary', () => {
  const result = layoutPreview(`${'a'.repeat(MAX_PREVIEW_CHARACTERS - 1)}😀tail`, 10_000, 15);
  assert.equal(result.truncated, true);
  assert.equal(result.lines[0].text, 'a'.repeat(MAX_PREVIEW_CHARACTERS - 1));
});

test('preview cache reuses layout and invalidates source, width, and row limits', () => {
  const cache = new PreviewLayoutCache();
  const option = { preview: 'Some words to wrap\nSecond row' };
  const first = cache.get(option, 10, 15);
  assert.equal(cache.get(option, 10, 15), first);
  const narrow = cache.get(option, 6, 15);
  assert.notEqual(narrow, first);
  assert.equal(cache.get(option, 6, 15), narrow);
  const short = cache.get(option, 6, 1);
  assert.notEqual(short, narrow);
  option.preview = 'Changed';
  assert.notEqual(cache.get(option, 6, 1), short);
});
