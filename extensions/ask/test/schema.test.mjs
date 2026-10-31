import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { Check } from 'typebox/value';
import {
  AskUserParams,
  MAX_OPTION_LABEL_LENGTH,
  MAX_QUESTION_LABEL_LENGTH,
  normalizeQuestions,
  summarizeQuestions,
  validateAskUserArguments,
  validateQuestions,
} from '../src/schema.ts';

const text = (extra = {}) => ({ id: 'text', prompt: 'Explain your goal', kind: 'text', ...extra });
const options = (count = 2) => Array.from({ length: count }, (_, index) => ({
  value: `stable-${index}`, label: `Option ${index + 1}`,
}));
const choice = (kind = 'single', extra = {}) => ({
  id: kind, prompt: 'Choose a target', kind, options: options(), ...extra,
});
const params = (...questions) => ({ questions });

function freezeDeep(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function rejectsStructure(args, path, reason) {
  const before = structuredClone(args);
  freezeDeep(args);
  const error = validateAskUserArguments(args);
  assert.equal(typeof error, 'string');
  assert.ok(error.startsWith('Invalid ask_user arguments'), 'keep the machine-readable prefix');
  if (path !== undefined) assert.ok(error.startsWith(`Invalid ask_user arguments at ${path}: `), error);
  if (reason !== undefined) assert.match(error, reason);
  assert.deepEqual(args, before, 'invalid input must not be repaired or otherwise mutated');
  return error;
}

function rejectsBusiness(question, message) {
  const args = params(question);
  assert.equal(validateAskUserArguments(args), undefined, 'business errors are structurally valid');
  assert.match(validateQuestions(normalizeQuestions(args)), message);
}

test('all three kinds accept their complete strict contracts without changing input', () => {
  const args = {
    title: 'Decisions',
    questions: [
      text({ label: 'Goal', description: 'Context', required: false }),
      choice('single', {
        label: 'Target', allowCustom: false, required: true, defaultValue: 'stable-1',
        options: [
          { value: 'stable-0', label: 'First', description: 'Details', preview: 'const x = 1;' },
          { value: 'stable-1', label: 'Second' },
        ],
      }),
      choice('multi', { description: 'Choose several', allowCustom: true, defaultValue: 'stable-0' }),
    ],
  };
  const before = structuredClone(args);
  freezeDeep(args);
  assert.equal(validateAskUserArguments(args), undefined);
  assert.equal(validateQuestions(normalizeQuestions(args)), undefined);
  assert.deepEqual(args, before);
});

test('kind, question IDs, option labels and prompts are required; a missing option value defaults to its label', () => {
  for (const key of ['kind', 'id', 'prompt']) {
    const question = text();
    delete question[key];
    rejectsStructure(params(question));
  }
  const noLabel = choice();
  delete noLabel.options[0].label;
  rejectsStructure(params(noLabel));
  const noValue = params(choice());
  delete noValue.questions[0].options[0].value;
  assert.equal(validateAskUserArguments(noValue), undefined, 'value is optional');
  const normalized = normalizeQuestions(noValue);
  assert.equal(normalized[0].options[0].value, normalized[0].options[0].label,
    'an omitted value must default to the label rather than being fabricated');
  assert.equal(validateQuestions(normalized), undefined);
  for (const kind of ['single', 'multi']) {
    const question = choice(kind);
    delete question.options;
    rejectsStructure(params(question));
  }
});

test('removed top-level description and extra fields at every object level are rejected', () => {
  for (const description of ['Legacy context', undefined]) {
    rejectsStructure({ ...params(text()), description });
  }
  rejectsStructure({ ...params(text()), extra: true });
  for (const kind of ['text', 'single', 'multi']) {
    rejectsStructure(params(kind === 'text' ? text({ extra: true }) : choice(kind, { extra: true })));
  }
  for (const kind of ['single', 'multi']) {
    const question = choice(kind);
    question.options[0].extra = true;
    rejectsStructure(params(question));
  }
});

test('text rejects options, allowCustom and defaultValue even when empty, false or undefined', () => {
  for (const extra of [
    { options: [] }, { options: options() }, { options: undefined },
    { allowCustom: false }, { allowCustom: true }, { allowCustom: undefined },
    { defaultValue: '' }, { defaultValue: 'stable-0' }, { defaultValue: undefined },
  ]) rejectsStructure(params(text(extra)));
});

test('preview is single-select only', () => {
  const single = choice();
  single.options[0].preview = 'A preview';
  assert.equal(validateAskUserArguments(params(single)), undefined);
  for (const preview of ['A preview', undefined]) {
    const multi = choice('multi');
    multi.options[0].preview = preview;
    rejectsStructure(params(multi));
  }
});

test('diagnostics select the actual kind and explain forbidden fields at their exact paths', () => {
  for (const field of ['options', 'allowCustom', 'defaultValue']) {
    rejectsStructure(params(text({ [field]: undefined })), `/questions/0/${field}`,
      new RegExp(`text questions must not include ${field}`));
  }
  for (const preview of ['Preview', undefined]) {
    const multi = choice('multi');
    multi.options[0].preview = preview;
    rejectsStructure(params(text(), multi), '/questions/1/options/0/preview',
      /preview is supported only for single questions/);
  }
});

test('required fields and kind diagnostics suggest what to provide without fabricating it', () => {
  rejectsStructure({}, '/questions', /required field; provide "questions"/);
  for (const key of ['id', 'prompt', 'kind']) {
    const question = text();
    delete question[key];
    rejectsStructure(params(question), `/questions/0/${key}`,
      key === 'kind' ? /required field; provide kind as "text", "single", or "multi"/ : new RegExp(`required field; provide "${key}"`));
  }
  for (const kind of ['unknown', null, 42, {}, ['text']]) {
    rejectsStructure(params(text({ kind })), '/questions/0/kind', /kind must be "text", "single", or "multi"/);
  }
  for (const kind of ['single', 'multi']) {
    const question = choice(kind);
    delete question.options;
    rejectsStructure(params(question), '/questions/0/options', new RegExp(`${kind} questions require options; provide 2-5 options`));
    const missingLabel = choice(kind);
    delete missingLabel.options[1].label;
    rejectsStructure(params(missingLabel), '/questions/0/options/1/label', /required field; provide "label"/);
    // `value` is optional: the caller may rely on the label being the returned value.
    const missingValue = choice(kind);
    delete missingValue.options[1].value;
    assert.equal(validateAskUserArguments(params(missingValue)), undefined);
  }
});

test('unknown fields at each object level identify the field and ask for its removal', () => {
  rejectsStructure({ ...params(text()), legacy: true }, '/legacy', /unknown field; remove it/);
  for (const kind of ['text', 'single', 'multi']) {
    const question = kind === 'text' ? text({ extra: true }) : choice(kind, { extra: true });
    rejectsStructure(params(question), '/questions/0/extra', /unknown field; remove it/);
  }
  for (const kind of ['single', 'multi']) {
    const question = choice(kind);
    question.options[1].extra = undefined;
    rejectsStructure(params(question), '/questions/0/options/1/extra', /unknown field; remove it/);
  }
});

test('wrong-type diagnostics retain the expected type and precise location, including null', () => {
  for (const [args, path, reason] of [
    [null, '/', /must be object/],
    [params(null), '/questions/0', /must be object/],
    [params([]), '/questions/0', /must be object/],
    [{ questions: null }, '/questions', /must be array/],
    [{ ...params(text()), title: 42 }, '/title', /must be string/],
    [params(text({ id: null })), '/questions/0/id', /must be string/],
    [params(text({ required: 'false' })), '/questions/0/required', /must be boolean/],
    [params(choice('single', { options: null })), '/questions/0/options', /must be array/],
    [params(choice('multi', { options: [null, options()[1]] })), '/questions/0/options/0', /must be object/],
    [params(choice('single', { options: [{ ...options()[0], value: null }, options()[1]] })), '/questions/0/options/0/value', /must be string/],
    [params(choice('single', { options: [{ ...options()[0], preview: false }, options()[1]] })), '/questions/0/options/0/preview', /must be string/],
  ]) rejectsStructure(args, path, reason);
});

test('diagnostics escape JSON Pointer field names and newlines, preserve Unicode, and omit payload values', () => {
  const field = '未知~/field\nnext\r\t\u0000\u007f\u009b2J\u061c\u200e\u2028\u2029\u202e\u2066';
  const escaped = '未知~0~1field\\u000anext\\u000d\\u0009\\u0000\\u007f\\u009b2J\\u061c\\u200e\\u2028\\u2029\\u202e\\u2066';
  const secret = 'PRIVATE-PAYLOAD\nDo not echo this';
  const top = { ...params(text({ prompt: secret })), [field]: { secret } };
  const question = params(text({ [field]: secret }));
  const option = choice('multi');
  option.options[0][field] = secret;
  for (const [args, path] of [
    [top, `/${escaped}`],
    [question, `/questions/0/${escaped}`],
    [params(option), `/questions/0/options/0/${escaped}`],
  ]) {
    const error = rejectsStructure(args, path, /unknown field; remove it/);
    assert.doesNotMatch(error, /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/, 'an untrusted field must not inject a diagnostic line or control character');
    assert.equal(error.includes(secret), false);
    assert.equal(error.includes('PRIVATE-PAYLOAD'), false);
  }
  const badValue = choice('single');
  badValue.options[0].value = { secret };
  const error = rejectsStructure(params(badValue), '/questions/0/options/0/value', /must be string/);
  assert.equal(error.includes('PRIVATE-PAYLOAD'), false);
});

test('Unicode and multiline text remain legal and unchanged, including IDs, values and previews', () => {
  const args = {
    title: '决策\n第二行',
    questions: [
      text({ id: '路径~/问题\n一', prompt: '请解释\n下一行 🌱', description: '上下文\n保持原样' }),
      choice('single', {
        options: [
          { value: '值~/一\n二', label: '选项 🌱', preview: '示例\nconst x = "✓";' },
          { value: '另一个', label: '保留' },
        ],
      }),
    ],
  };
  const before = structuredClone(args);
  freezeDeep(args);
  assert.equal(validateAskUserArguments(args), undefined);
  const normalized = normalizeQuestions(args);
  assert.equal(validateQuestions(normalized), undefined);
  assert.equal(normalized[0].id, args.questions[0].id);
  assert.equal(normalized[1].options[0].value, args.questions[1].options[0].value);
  assert.deepEqual(args, before);
});

test('choice options enforce 2–5 entries, independently of allowCustom', () => {
  for (const kind of ['single', 'multi']) {
    for (const count of [0, 1, 6]) {
      for (const allowCustom of [true, false]) {
        rejectsStructure(params(choice(kind, { options: options(count), allowCustom })));
      }
    }
    for (const count of [2, 3, 4, 5]) {
      const args = params(choice(kind, { options: options(count) }));
      assert.equal(validateAskUserArguments(args), undefined);
      assert.equal(validateQuestions(normalizeQuestions(args)), undefined);
    }
  }
});

test('wrong types are rejected without coercion', () => {
  for (const args of [
    null, undefined, true, 0, 'questions', [], {}, { questions: null }, { questions: {} },
    { ...params(text()), title: 123 }, params(null), params('text'),
    params(text({ id: 42 })), params(text({ prompt: false })),
    params(text({ kind: 'unknown' })), params(text({ kind: null })),
    params(text({ label: 1 })), params(text({ description: [] })),
    params(text({ required: 'false' })), params(choice('single', { allowCustom: 'true' })),
    params(choice('single', { defaultValue: 0 })),
    params(choice('multi', { defaultValue: ['stable-0'] })),
    params(choice('single', { options: ['first', 'second'] })),
    params(choice('single', { options: [{ value: 1, label: 'One' }, { value: 'b', label: 'Two' }] })),
    params(choice('single', { options: [{ value: 'a', label: false }, { value: 'b', label: 'Two' }] })),
    params(choice('single', { options: [{ value: 'a', label: 'One', preview: 1 }, { value: 'b', label: 'Two' }] })),
    params(choice('multi', { options: [{ value: 'a', label: 'One', description: null }, { value: 'b', label: 'Two' }] })),
  ]) rejectsStructure(args);
});

test('question count limits are structural and also checked for normalized callers', () => {
  rejectsStructure(params());
  rejectsStructure(params(...Array.from({ length: 6 }, (_, i) => text({ id: `q${i}` }))));
  const questions = Array.from({ length: 5 }, (_, i) => text({ id: `q${i}` }));
  assert.equal(validateAskUserArguments(params(...questions)), undefined);
  assert.match(validateQuestions([]), /At least one/);
  const normalized = normalizeQuestions(params(...questions, text({ id: 'sixth' })));
  assert.match(validateQuestions(normalized), /At most 5/);
});

test('normalization only fills defaults and keeps stable IDs, values and optional descriptions intact', () => {
  const args = params(
    text({ id: '  stable text ID  ' }),
    choice('single', { options: [{ value: '  fixed value  ', label: 'Original label' }, { value: 'B', label: 'Second' }] }),
    choice('multi', { label: 'Explicit', required: false, allowCustom: false, defaultValue: 'stable-1' }),
  );
  const before = structuredClone(args);
  freezeDeep(args);
  assert.equal(validateAskUserArguments(args), undefined);
  const normalized = normalizeQuestions(args);
  assert.deepEqual(normalized[0], {
    id: '  stable text ID  ', label: 'Q1', prompt: args.questions[0].prompt,
    kind: 'text', description: undefined, options: [], allowCustom: true,
    required: true, defaultValue: undefined,
  });
  assert.equal(normalized[1].label, 'Q2');
  assert.equal(normalized[1].allowCustom, true);
  assert.deepEqual(normalized[1].options, before.questions[1].options);
  assert.equal(normalized[1].options[0].value, '  fixed value  ');
  assert.equal(normalized[2].label, 'Explicit');
  assert.equal(normalized[2].allowCustom, false);
  assert.equal(normalized[2].required, false);
  assert.equal(normalized[2].defaultValue, 'stable-1');
  assert.equal(validateQuestions(normalized), undefined);
  assert.deepEqual(args, before);
});

test('blank IDs, prompts, labels and option values remain intact and fail business validation', () => {
  for (const field of ['id', 'prompt', 'label']) {
    for (const value of ['', ' \t\n ']) {
      const args = params(text({ [field]: value }));
      assert.equal(validateAskUserArguments(args), undefined);
      const normalized = normalizeQuestions(args);
      assert.equal(normalized[0][field], value, 'normalization must not repair an explicit blank');
      assert.match(validateQuestions(normalized), /must not be empty/);
    }
  }
  for (const field of ['value', 'label']) {
    for (const value of ['', ' \t\n ']) {
      const question = choice();
      question.options[0][field] = value;
      rejectsBusiness(question, /empty (?:value|label)/);
    }
  }
});

test('duplicate question IDs, option values and option labels are business errors', () => {
  const duplicateIds = params(text({ id: 'same' }), choice('multi', { id: 'same' }));
  assert.equal(validateAskUserArguments(duplicateIds), undefined);
  assert.match(validateQuestions(normalizeQuestions(duplicateIds)), /Duplicate question id/);
  for (const field of ['value', 'label']) {
    const question = choice();
    question.options[1][field] = question.options[0][field];
    rejectsBusiness(question, new RegExp(`duplicate option ${field}`));
  }
});

test('unmatched string defaults are business errors', () => {
  for (const kind of ['single', 'multi']) {
    for (const defaultValue of ['', 'missing', ' stable-0 ']) {
      rejectsBusiness(choice(kind, { defaultValue }), /defaultValue must match an option value/);
    }
    const args = params(choice(kind, { defaultValue: 'stable-0' }));
    assert.equal(validateQuestions(normalizeQuestions(args)), undefined);
  }
});

test('existing question and option label lengths remain enforced structurally and in business validation', () => {
  const longest = choice('single', { label: 'Q'.repeat(MAX_QUESTION_LABEL_LENGTH) });
  longest.options[0].label = 'O'.repeat(MAX_OPTION_LABEL_LENGTH);
  assert.equal(validateAskUserArguments(params(longest)), undefined);
  assert.equal(validateQuestions(normalizeQuestions(params(longest))), undefined);
  const longQuestion = choice('single', { label: 'Q'.repeat(MAX_QUESTION_LABEL_LENGTH + 1) });
  rejectsStructure(params(longQuestion));
  assert.match(validateQuestions(normalizeQuestions(params(longQuestion))), /label exceeds 24/);
  const longOption = choice();
  longOption.options[0].label = 'O'.repeat(MAX_OPTION_LABEL_LENGTH + 1);
  rejectsStructure(params(longOption));
  assert.match(validateQuestions(normalizeQuestions(params(longOption))), /label exceeding 120/);
});

test('label length uses the same code-point unit in structure and business validation', () => {
  // Astral characters are 2 UTF-16 units but 1 code point; TypeBox counts code points.
  const astral = choice('single', { label: '🙂'.repeat(MAX_QUESTION_LABEL_LENGTH) });
  astral.options[0].label = '🙂'.repeat(MAX_OPTION_LABEL_LENGTH);
  assert.equal(validateAskUserArguments(params(astral)), undefined);
  assert.equal(validateQuestions(normalizeQuestions(params(astral))), undefined);
  const tooLong = choice();
  tooLong.options[0].label = '🙂'.repeat(MAX_OPTION_LABEL_LENGTH + 1);
  rejectsStructure(params(tooLong));
  assert.match(validateQuestions(normalizeQuestions(params(tooLong))), /label exceeding 120/);
});

test('business validation independently refuses empty/undersized choices even with custom answers enabled', () => {
  for (const kind of ['single', 'multi']) {
    for (const count of [0, 1, 6]) {
      const normalized = normalizeQuestions(params(choice(kind, { options: options(count), allowCustom: true })));
      assert.match(validateQuestions(normalized), count < 2 ? /at least 2 options/ : /maximum of 5/);
    }
  }
  const normalizedText = normalizeQuestions(params(text()));
  assert.match(validateQuestions([{ ...normalizedText[0], options: options() }]), /text but also provides options/);
  assert.match(validateQuestions([{ ...normalizedText[0], defaultValue: 'a' }]), /text but provides defaultValue/);
  assert.match(validateQuestions([{ ...normalizedText[0], kind: 'unknown' }]), /invalid kind/);
});

test('prototype-like IDs and values are legal stable strings, not implicit duplicates', () => {
  const identifiers = ['__proto__', 'constructor', 'toString'];
  const args = params(...identifiers.map((id) => choice('single', {
    id, options: identifiers.map((value) => ({ value, label: value })), defaultValue: '__proto__',
  })));
  assert.equal(validateAskUserArguments(args), undefined);
  const normalized = normalizeQuestions(args);
  assert.equal(validateQuestions(normalized), undefined);
  assert.deepEqual(normalized.map((question) => question.id), identifiers);
  assert.deepEqual(normalized[0].options.map((option) => option.value), identifiers);
});

test('question summaries project exactly four fields without changing internal questions', () => {
  const normalized = normalizeQuestions(params(
    text({ description: 'Private context' }),
    choice('single', { defaultValue: 'stable-0', required: false }),
  ));
  const before = structuredClone(normalized);
  freezeDeep(normalized);
  const summaries = summarizeQuestions(normalized);
  assert.deepEqual(summaries, [
    { id: 'text', label: 'Q1', kind: 'text', required: true },
    { id: 'single', label: 'Q2', kind: 'single', required: false },
  ]);
  assert.deepEqual(normalized, before);
  summaries[0].label = 'Changed summary';
  assert.equal(normalized[0].label, 'Q1');
});

test('the three-branch schema is serializable JSON Schema with closed objects at every level', () => {
  const schema = JSON.parse(JSON.stringify(AskUserParams));
  assert.equal(schema.type, 'object');
  const branches = schema.properties.questions.items.anyOf;
  assert.equal(branches.length, 3);
  assert.deepEqual(branches.map((branch) => branch.properties.kind.const), ['text', 'single', 'multi']);
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object') assert.equal(node.additionalProperties, false);
    for (const child of Object.values(node)) visit(child);
  };
  visit(schema);
  for (const branch of branches) {
    for (const required of ['id', 'prompt', 'kind']) assert.ok(branch.required.includes(required));
  }
  assert.deepEqual(Object.keys(branches[0].properties).sort(), ['description', 'id', 'kind', 'label', 'prompt', 'required']);
  for (const branch of branches.slice(1)) assert.ok(branch.required.includes('options'));
  assert.equal(Check(schema, params(text(), choice(), choice('multi'))), true);
  assert.equal(Check(schema, { ...params(text()), description: 'Removed' }), false);
});

test('static input and result types expose only the new shared contract', () => {
  // Compile an in-memory fixture so type assertions require no files or build output.
  const fixturePath = fileURLToPath(new URL('./__schema_contract_types__.ts', import.meta.url)).replaceAll('\\', '/');
  const source = `
    import type { AskUserAnswer, AskUserParamsType, AskUserQuestionSummary, AskUserResult } from '../src/schema.ts';
    import { summarizeQuestions } from '../src/schema.ts';
    const text: AskUserParamsType = { questions: [{ id: 'q', prompt: 'P', kind: 'text' }] };
    // @ts-expect-error kind is required
    const noKind: AskUserParamsType = { questions: [{ id: 'q', prompt: 'P' }] };
    // @ts-expect-error text cannot carry options
    const textOptions: AskUserParamsType = { questions: [{ id: 'q', prompt: 'P', kind: 'text', options: [] }] };
    // @ts-expect-error top-level description is removed
    const legacy: AskUserParamsType = { questions: [], description: 'legacy' };
    const summaries: AskUserQuestionSummary[] = summarizeQuestions([]);
    const result: AskUserResult = {
      title: 'T', questions: summaries, answers: [], cancelled: false,
      notes: { q: 'note' }, skippedIds: ['q'], unresolvedRequiredIds: ['q'], error: 'error',
    };
    // @ts-expect-error answers require a stable id
    const noAnswerId: AskUserAnswer = { kind: 'text', value: 'a', label: 'A' };
    // @ts-expect-error answers require an explicit kind
    const noAnswerKind: AskUserAnswer = { id: 'q', value: 'a', label: 'A' };
    const textAnswer: AskUserAnswer = {
      id: 'text', kind: 'text', value: 'a', label: 'A',
      wasCustom: true, wasDefault: false, customValues: ['a'],
    };
    const singleAnswer: AskUserAnswer = {
      id: 'single', kind: 'single', value: 'a', label: 'A',
      wasCustom: false, wasDefault: true, customValues: [],
    };
    const answer: AskUserAnswer = {
      id: 'multi', kind: 'multi', values: ['a'], labels: ['A'],
      wasCustom: true, wasDefault: false, customValues: ['custom'],
    };
    // @ts-expect-error text requires value
    const textWithoutValue: AskUserAnswer = { id: 'q', kind: 'text', label: 'A' };
    // @ts-expect-error text requires label
    const textWithoutLabel: AskUserAnswer = { id: 'q', kind: 'text', value: 'a' };
    // @ts-expect-error single requires value
    const singleWithoutValue: AskUserAnswer = { id: 'q', kind: 'single', label: 'A' };
    // @ts-expect-error single requires label
    const singleWithoutLabel: AskUserAnswer = { id: 'q', kind: 'single', value: 'a' };
    // @ts-expect-error multi requires values
    const multiWithoutValues: AskUserAnswer = { id: 'q', kind: 'multi', labels: ['A'] };
    // @ts-expect-error multi requires labels
    const multiWithoutLabels: AskUserAnswer = { id: 'q', kind: 'multi', values: ['a'] };
    // @ts-expect-error text cannot carry values
    const textWithValues: AskUserAnswer = { id: 'q', kind: 'text', value: 'a', label: 'A', values: ['a'] };
    // @ts-expect-error text cannot carry labels
    const textWithLabels: AskUserAnswer = { id: 'q', kind: 'text', value: 'a', label: 'A', labels: ['A'] };
    // @ts-expect-error single cannot carry values
    const singleWithValues: AskUserAnswer = { id: 'q', kind: 'single', value: 'a', label: 'A', values: ['a'] };
    // @ts-expect-error single cannot carry labels
    const singleWithLabels: AskUserAnswer = { id: 'q', kind: 'single', value: 'a', label: 'A', labels: ['A'] };
    // @ts-expect-error multi cannot carry value
    const multiWithValue: AskUserAnswer = { id: 'q', kind: 'multi', values: ['a'], labels: ['A'], value: 'a' };
    // @ts-expect-error multi cannot carry label
    const multiWithLabel: AskUserAnswer = { id: 'q', kind: 'multi', values: ['a'], labels: ['A'], label: 'A' };
    const leaked = { ...singleAnswer, values: ['a'] };
    // @ts-expect-error cross-kind values remain forbidden even through a non-fresh object
    const leakedAnswer: AskUserAnswer = leaked;
    function narrow(answer: AskUserAnswer) {
      if (answer.kind === 'multi') {
        const values: string[] = answer.values;
        const labels: string[] = answer.labels;
      } else {
        const value: string = answer.value;
        const label: string = answer.label;
      }
      if (answer.kind === 'text') {
        const kind: 'text' = answer.kind;
      }
      if (answer.kind === 'single') {
        const kind: 'single' = answer.kind;
      }
    }
    // @ts-expect-error answer status is removed
    answer.status;
    // @ts-expect-error answer index is removed
    answer.index;
    // @ts-expect-error result description is removed
    result.description;
    // @ts-expect-error results contain summaries, not full questions
    result.questions[0].prompt;
    // @ts-expect-error result questions cannot expose options
    result.questions[0].options;
    // @ts-expect-error result questions cannot expose custom answer settings
    result.questions[0].allowCustom;
  `;
  const compilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2024,
    strict: true, skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true,
  };
  const host = ts.createCompilerHost(compilerOptions);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => name === fixturePath
    ? ts.createSourceFile(name, source, languageVersion, true)
    : originalGetSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([fixturePath], compilerOptions, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: host.getCurrentDirectory,
    getNewLine: () => '\n',
  }));
});
