import assert from 'node:assert/strict';
import test from 'node:test';
import { getInlineMaxHeight, INLINE_MAX_HEIGHT, resolveViewport } from '../src/viewport.ts';

test('inline content budget reserves host chrome without any overlay margin or width cap', () => {
  assert.equal(INLINE_MAX_HEIGHT, 14);
  for (const [rows, expected] of [[1, 1], [4, 1], [8, 4], [12, 8], [24, 14], [40, 14], [120, 14]]) {
    assert.equal(getInlineMaxHeight(rows), expected);
  }
  assert.equal(getInlineMaxHeight(12.9), 8);
  assert.equal(getInlineMaxHeight(NaN), 14);
  assert.equal(getInlineMaxHeight(Infinity), 14);
  assert.equal(getInlineMaxHeight(-8), 1);
});

test('viewport clamps offsets at both ends', () => {
  assert.deepEqual(resolveViewport(20, 5, -8), { start: 0, end: 5, hiddenBefore: 0, hiddenAfter: 15 });
  assert.deepEqual(resolveViewport(20, 5, 50), { start: 15, end: 20, hiddenBefore: 15, hiddenAfter: 0 });
  assert.deepEqual(resolveViewport(0, 5, 10), { start: 0, end: 0, hiddenBefore: 0, hiddenAfter: 0 });
});

test('viewport reveals wrapped anchors in either direction', () => {
  assert.equal(resolveViewport(20, 5, 10, { start: 3, end: 5 }).start, 3);
  assert.equal(resolveViewport(20, 5, 0, { start: 10, end: 13 }).start, 8);
  assert.equal(resolveViewport(20, 5, 8, { start: 10, end: 13 }).start, 8);
});

test('oversized anchors start at their first line and remain manually scrollable', () => {
  assert.equal(resolveViewport(20, 3, 8, { start: 5, end: 15 }).start, 5);
  assert.equal(resolveViewport(20, 3, 8).start, 8);
});

test('viewport always reserves at least one content line', () => {
  assert.deepEqual(resolveViewport(3, 0, 0, { start: 2, end: 3 }), {
    start: 2, end: 3, hiddenBefore: 2, hiddenAfter: 0,
  });
});
