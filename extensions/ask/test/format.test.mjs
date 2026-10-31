import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerDisplay, makeCancelledResult, makeErrorResult, summarizeResult } from '../src/format.ts';
import { normalizeQuestions } from '../src/schema.ts';
import { answerSourceLabel, unresolvedWarning } from '../src/ui-copy.ts';

function questions() {
  return normalizeQuestions({ questions: [
    { id: 'decision', label: '决定', prompt: 'Choose', description: 'Context', kind: 'single', options: [
      { value: 'a', label: 'Alpha', preview: 'Long preview' }, { value: 'b', label: 'Beta' },
    ] },
    { id: 'context', prompt: 'Explain', kind: 'text', required: false },
  ] });
}

function freezeDeep(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

test('early error factory uses named context and projects only compact question metadata', () => {
  const input = freezeDeep(questions());
  const before = structuredClone(input);
  const result = makeErrorResult('Invalid decision', { title: '请确认', questions: input });
  assert.deepEqual(result.content, [{ type: 'text', text: 'Error: Invalid decision' }]);
  assert.equal(result.isError, true);
  assert.equal(result.details.cancelled, false, 'an error result must not be reported as a user cancellation');
  assert.equal(result.details.error, 'Invalid decision');
  assert.deepEqual(result.details.answers, []);
  assert.deepEqual(result.details.unresolvedRequiredIds, ['decision']);
  assert.deepEqual(result.details.questions, [
    { id: 'decision', label: '决定', kind: 'single', required: true },
    { id: 'context', label: 'Q2', kind: 'text', required: false },
  ]);
  assert.ok(!('description' in result.details));
  assert.deepEqual(input, before);
  assert.equal(summarizeResult(result.details), 'Question flow failed: Invalid decision');
});

test('early cancellation is not an error or an approval and keeps supplied context immutable', () => {
  const input = freezeDeep(questions());
  const result = makeCancelledResult({ title: 'Cancelled decision', questions: input });
  assert.equal('isError' in result, false);
  assert.equal(result.details.cancelled, true);
  assert.equal(result.details.error, undefined);
  assert.deepEqual(result.details.answers, []);
  assert.equal(result.details.questions.length, 2);
  assert.deepEqual(result.content, [{ type: 'text', text: 'User cancelled the questions' }]);
  assert.deepEqual(result.details.unresolvedRequiredIds, ['decision']);
  const summary = summarizeResult(result.details);
  assert.match(summary, /^User cancelled the questions\. Unresolved required questions: \["decision"\]/);
  assert.match(summary, /cancellation is not approval/);
});

test('early factories share a concise Chinese default title without positional placeholder arguments', () => {
  for (const result of [makeErrorResult('Bad input'), makeCancelledResult()]) {
    assert.equal(result.details.title, '请确认');
    assert.deepEqual(result.details.questions, []);
    assert.deepEqual(result.details.answers, []);
    assert.deepEqual(result.details.unresolvedRequiredIds, []);
  }
  // Only a real cancellation reports itself as cancelled; errors stay errors.
  assert.equal(makeErrorResult('Bad input').details.cancelled, false);
  assert.equal(makeCancelledResult().details.cancelled, true);
  const emptyError = makeErrorResult('');
  assert.equal(emptyError.isError, true, 'an explicitly supplied error must not become cancellation');
  assert.equal(summarizeResult(emptyError.details), 'Question flow failed: ');
});

test('UI provenance is localized while model values and source flags remain unchanged', () => {
  const text = { id: 'text', kind: 'text', value: 'raw input', label: '原始输入', wasCustom: true };
  const single = { id: 'single', kind: 'single', value: 'stable', label: '原始选项', wasDefault: true, wasCustom: false };
  const multi = { id: 'multi', kind: 'multi', values: ['a', 'extra'], labels: ['Alpha', '自填原文'], customValues: ['extra'], wasCustom: true };
  const answers = freezeDeep([text, single, multi]);
  const before = structuredClone(answers);
  assert.equal(answerSourceLabel(text), '（自填）');
  assert.equal(answerSourceLabel(single), '（默认）');
  assert.equal(answerSourceLabel(multi), '（自填）');
  assert.equal(answerDisplay(text), '原始输入');
  assert.equal(answerDisplay(single), '原始选项');
  assert.equal(answerDisplay(multi), 'Alpha, 自填原文');
  const result = summarizeResult({ title: 'T', questions: answers.map(({ id, kind }) => ({ id, label: id, kind, required: true })), answers, cancelled: false });
  assert.match(result, /"value":"raw input"/);
  assert.match(result, /"value":"stable"/);
  assert.match(result, /"typed":true/);
  assert.match(result, /"default":true/);
  assert.match(result, /A skipped question is not approval/);
  assert.deepEqual(answers, before);
});

test('localized transcript warning preserves explicit not-approval semantics and model guidance', () => {
  assert.equal(unresolvedWarning(['decision']), '待确认：decision。跳过和附加说明不代表批准。');
  const result = summarizeResult({
    title: 'T', questions: [{ id: 'decision', label: '决定', kind: 'single', required: true }],
    answers: [], cancelled: false, skippedIds: ['decision'], notes: { decision: 'context only' }, unresolvedRequiredIds: ['decision'],
  });
  assert.match(result, /unresolvedRequiredIds=\["decision"\]/);
  assert.match(result, /not approval/);
  assert.match(result, /do not proceed/);
});
