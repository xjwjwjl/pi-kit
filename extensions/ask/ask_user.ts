/**
 * Ask User Tool - ask the user structured follow-up questions
 *
 * Combines question.ts' inline custom answer flow with questionnaire.ts' multi-question tabs.
 * Supports text, single choice, multiple choice, and custom answers.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

const QUESTION_KINDS = ["text", "single", "multi"] as const;
const MAX_QUESTIONS = 5;
const MIN_CHOICE_OPTIONS = 2;
const MAX_CHOICE_OPTIONS = 5;
const MAX_QUESTION_LABEL_LENGTH = 24;
const MAX_OPTION_LABEL_LENGTH = 120;
const RESERVED_OPTION_LABELS = ["Other", "Type something.", "Skip", "Next →"] as const;
type QuestionKind = (typeof QUESTION_KINDS)[number];
type AnswerStatus = "answered";

const ANSI_RESET = "\x1b[0m";

function truncatePlainText(text: string, width: number, ellipsis = "…"): string {
	return truncateToWidth(text.replace(/[\x00-\x1f\x7f-\x9f]/g, ""), width, ellipsis).replaceAll(ANSI_RESET, "");
}

function truncateStyledText(text: string, width: number, ellipsis = "..."): string {
	if (width <= visibleWidth(ellipsis)) return truncateToWidth(text, width, "");
	const truncated = truncateToWidth(text, width, ellipsis);
	const suffix = `${ANSI_RESET}${ellipsis}${ANSI_RESET}`;
	return truncated.endsWith(suffix) ? `${truncated.slice(0, -suffix.length)}${ellipsis}${ANSI_RESET}` : truncated;
}

type ActionOption =
	| (AskUserOption & { type: "option"; index: number })
	| { type: "custom"; value: "__custom__"; label: string; index: number }
	| { type: "customValue"; value: string; label: string; index: number }
	| { type: "skip"; value: "__skip__"; label: string; index: number };

interface AskUserOption {
	value: string;
	label: string;
	description?: string;
	preview?: string;
}

interface NormalizedQuestion {
	id: string;
	label: string;
	prompt: string;
	kind: QuestionKind;
	description?: string;
	options: AskUserOption[];
	allowCustom: boolean;
	required: boolean;
	defaultValue?: string;
}

interface AskUserAnswer {
	id: string;
	kind: QuestionKind;
	status: AnswerStatus;
	value?: string;
	label?: string;
	values?: string[];
	labels?: string[];
	wasCustom?: boolean;
	wasDefault?: boolean;
	customValues?: string[];
	index?: number;
}

interface AskUserResult {
	title: string;
	description?: string;
	questions: NormalizedQuestion[];
	answers: AskUserAnswer[];
	cancelled: boolean;
	skippedIds?: string[];
	error?: string;
}

// Schema
const AskUserOptionSchema = Type.Object({
	value: Type.String({ description: "The stable value returned when selected" }),
	label: Type.String({
		maxLength: MAX_OPTION_LABEL_LENGTH,
		description: `Display label for the option. Keep it concise; max ${MAX_OPTION_LABEL_LENGTH} characters.`,
	}),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
	preview: Type.Optional(Type.String({ description: "Optional preview content shown when this option is focused. Use for code snippets, mockups, config examples, or diagrams to help the user compare options visually. Only rendered for single-select (kind='single') questions." })),
});

const AskUserQuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	label: Type.Optional(
		Type.String({
			maxLength: MAX_QUESTION_LABEL_LENGTH,
			description: `Short contextual label for the tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2). Max ${MAX_QUESTION_LABEL_LENGTH} characters.`,
		}),
	),
	prompt: Type.String({ description: "The full question text to display" }),
	kind: Type.Optional(
		StringEnum(QUESTION_KINDS, {
			description: "Question type: text for free text, single for one option, multi for multiple options",
		}),
	),
	description: Type.Optional(Type.String({ description: "Optional explanatory text shown below the prompt" })),
	options: Type.Optional(
		Type.Array(AskUserOptionSchema, {
			minItems: MIN_CHOICE_OPTIONS,
			maxItems: MAX_CHOICE_OPTIONS,
			description: `Choice options for single/multi questions. Use ${MIN_CHOICE_OPTIONS}-${MAX_CHOICE_OPTIONS} options when options are provided.`,
		}),
	),
	allowCustom: Type.Optional(Type.Boolean({ description: "Allow a custom free-text answer for choice questions (default: true)" })),
	required: Type.Optional(Type.Boolean({ description: "Whether an answer is required (default: true)" })),
	defaultValue: Type.Optional(Type.String({ description: "Option value selected by default for single or multi questions" })),
});

const AskUserParams = Type.Object({
	title: Type.Optional(Type.String({ description: "Title for the ask-user panel" })),
	description: Type.Optional(Type.String({ description: "Optional explanation shown to the user" })),
	questions: Type.Array(AskUserQuestionSchema, {
		minItems: 1,
		maxItems: MAX_QUESTIONS,
		description: `Questions to ask the user. Ask only what is necessary to proceed. Maximum ${MAX_QUESTIONS} questions per call.`,
	}),
});

type AskUserParamsType = Static<typeof AskUserParams>;

function makeResult(
	message: string,
	title = "Ask user",
	description: string | undefined = undefined,
	questions: NormalizedQuestion[] = [],
	answers: AskUserAnswer[] = [],
	cancelled = true,
	error?: string,
): { content: { type: "text"; text: string }[]; details: AskUserResult } {
	return {
		content: [{ type: "text", text: message }],
		details: { title, description, questions, answers, cancelled, error },
	};
}

function inferKind(q: AskUserParamsType["questions"][number]): QuestionKind {
	if (q.kind) return q.kind;
	return q.options && q.options.length > 0 ? "single" : "text";
}

function normalizeQuestions(params: AskUserParamsType): NormalizedQuestion[] {
	return params.questions.map((q: AskUserParamsType["questions"][number], i: number) => {
		const kind = inferKind(q);
		return {
			id: q.id,
			label: q.label || `Q${i + 1}`,
			prompt: q.prompt,
			kind,
			description: q.description,
			options: q.options || [],
			allowCustom: kind === "text" ? true : q.allowCustom !== false,
			required: q.required !== false,
			defaultValue: q.defaultValue,
		};
	});
}

function validateQuestions(questions: NormalizedQuestion[]): string | undefined {
	if (questions.length === 0) return "At least one question is required";
	if (questions.length > MAX_QUESTIONS) return `At most ${MAX_QUESTIONS} questions are allowed per call`;

	const ids = new Set<string>();
	for (const q of questions) {
		if (!q.id.trim()) return "Question id must not be empty";
		if (ids.has(q.id)) return `Duplicate question id: ${q.id}`;
		ids.add(q.id);

		if (!q.prompt.trim()) return `Question '${q.id}' prompt must not be empty`;
		if (!QUESTION_KINDS.includes(q.kind)) return `Question '${q.id}' has invalid kind: ${q.kind}`;
		if (q.label.length > MAX_QUESTION_LABEL_LENGTH) {
			return `Question '${q.id}' label exceeds ${MAX_QUESTION_LABEL_LENGTH} characters`;
		}

		if (q.kind === "text") {
			if (q.options.length > 0) return `Question '${q.id}' is text but also provides options`;
			if (q.defaultValue !== undefined) return `Question '${q.id}' is text but provides defaultValue`;
			continue;
		}

		if (q.options.length === 0 && !q.allowCustom) {
			return `Question '${q.id}' has no options and does not allow custom answers`;
		}
		if (q.options.length === 1) {
			return `Question '${q.id}' must provide at least ${MIN_CHOICE_OPTIONS} options when options are used`;
		}
		if (q.options.length > MAX_CHOICE_OPTIONS) {
			return `Question '${q.id}' exceeds the maximum of ${MAX_CHOICE_OPTIONS} options`;
		}

		const optionValues = new Set<string>();
		const optionLabels = new Set<string>();
		for (const opt of q.options) {
			if (!opt.value.trim()) return `Question '${q.id}' has an option with an empty value`;
			if (!opt.label.trim()) return `Question '${q.id}' has an option with an empty label`;
			if (opt.label.length > MAX_OPTION_LABEL_LENGTH) {
				return `Question '${q.id}' has an option label exceeding ${MAX_OPTION_LABEL_LENGTH} characters`;
			}
			if (RESERVED_OPTION_LABELS.includes(opt.label as (typeof RESERVED_OPTION_LABELS)[number])) {
				return `Question '${q.id}' uses a reserved option label: ${opt.label}`;
			}
			if (optionValues.has(opt.value)) return `Question '${q.id}' has duplicate option value: ${opt.value}`;
			if (optionLabels.has(opt.label)) return `Question '${q.id}' has duplicate option label: ${opt.label}`;
			optionValues.add(opt.value);
			optionLabels.add(opt.label);
		}
		if (q.defaultValue !== undefined && !optionValues.has(q.defaultValue)) {
			return `Question '${q.id}' defaultValue must match an option value`;
		}
	}
	return undefined;
}

function answerDisplay(answer: AskUserAnswer): string {
	if (answer.kind === "multi") {
		const labels = answer.labels || [];
		return labels.length ? labels.join(", ") : "(none)";
	}
	return answer.label || answer.value || "(empty)";
}

function formatAnswerForModel(answer: AskUserAnswer): string {
	if (answer.kind === "multi") {
		const values = answer.values || [];
		if (values.length === 0) return "(none)";
		return JSON.stringify({ values, labels: answer.labels || [], typed: answer.wasCustom || undefined, default: answer.wasDefault || undefined });
	}
	const value = answer.value || answer.label || "(empty)";
	return JSON.stringify({ value, label: answer.label || value, typed: answer.wasCustom || undefined, default: answer.wasDefault || undefined });
}

function summarizeResult(result: AskUserResult): string {
	if (result.cancelled) return result.error ? `Question flow failed: ${result.error}` : "User cancelled the questions";
	const segments: string[] = [];
	for (const answer of result.answers) {
		const q = result.questions.find((question) => question.id === answer.id);
		segments.push(`${answer.id}=${formatAnswerForModel(answer)} (label: ${JSON.stringify(q?.label || answer.id)})`);
	}
	if (result.skippedIds?.length) segments.push(`skipped=${JSON.stringify(result.skippedIds)}`);
	if (segments.length === 0) return "User did not answer any questions.";
	return `User answers: ${segments.join(". ")}. You can continue with the user's answers in mind.`;
}

function clampOptionIndex(index: number, count: number): number {
	if (count <= 0) return 0;
	return Math.max(0, Math.min(count - 1, index));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function prepareAskUserArguments(args: unknown): unknown {
	if (!isRecord(args) || !Array.isArray(args.questions)) return args;

	let changed = false;
	const questions = args.questions.map((candidate) => {
		if (!isRecord(candidate) || !Array.isArray(candidate.options)) return candidate;

		const kind = typeof candidate.kind === "string" ? candidate.kind : undefined;
		const shouldOmitOptions = candidate.options.length === 0 || kind === "text";
		if (!shouldOmitOptions) return candidate;

		const next = { ...candidate };
		delete next.options;
		changed = true;
		return next;
	});

	return changed ? { ...args, questions } : args;
}

export default function askUser(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user concise follow-up questions in interactive TUI mode when user input is necessary to continue. Supports free text, single choice, multiple choice, and custom answers.",
		promptSnippet:
			`Use ask_user only in interactive TUI when a user decision, preference, or approval is required and cannot be inferred from context or discovered with tools. Batch related questions (up to ${MAX_QUESTIONS}). Do not use it for status updates, quizzes, or information already available.`,
		promptGuidelines: [
			"Outside interactive TUI mode, do not call ask_user; state the limitation or proceed with a safe explicit assumption.",
			"Use kind='text' for open-ended answers only when structured options would be premature or too constraining. Omit options entirely for text questions; never send options: [] for text input.",
			`Use kind='single' when exactly one option should be chosen. When providing options, write ${MIN_CHOICE_OPTIONS}-${MAX_CHOICE_OPTIONS} concise, mutually exclusive choices with stable values and short labels (max ${MAX_OPTION_LABEL_LENGTH} characters). Use options[].preview to attach code snippets, config samples, or ASCII diagrams when visual comparison helps the user decide.`,
			`Use kind='multi' only when multiple options may all be valid at the same time. When providing options, write ${MIN_CHOICE_OPTIONS}-${MAX_CHOICE_OPTIONS} concise, non-overlapping choices with stable values and short labels (max ${MAX_OPTION_LABEL_LENGTH} characters). Do not use multi-select for mutually exclusive choices.`,
			"Use required: false only when a question can safely be skipped. Set defaultValue only for a reusable preference the user has already stated; it must equal an existing single or multi option value and must not bypass a new decision.",
			"Do not author reserved labels such as 'Other', 'Type something.', or 'Skip' yourself; the UI adds these affordances automatically when appropriate.",
		],
		prepareArguments(args: unknown) {
			return prepareAskUserArguments(args);
		},
		parameters: AskUserParams,
		executionMode: "sequential",

		async execute(_toolCallId: string, params: AskUserParamsType, _signal: AbortSignal, _onUpdate: unknown, ctx: Record<string, unknown>) {
			const title = params.title || "Ask user";
			const description = params.description;
			const mode = typeof ctx.mode === "string" ? ctx.mode : undefined;

			if (mode !== "tui") {
				const error = ctx.hasUI === true ? `ask_user requires interactive TUI mode (current mode: ${mode || "unknown"})` : "UI not available";
				return makeResult(`Error: ${error}`, title, description, [], [], true, error);
			}

			const questions = normalizeQuestions(params);
			const validationError = validateQuestions(questions);
			if (validationError) {
				return makeResult(`Error: ${validationError}`, title, description, questions, [], true, validationError);
			}

			const isMulti = questions.length > 1;
			const totalTabs = questions.length + 1; // questions + Submit

			const result: AskUserResult = await (ctx as any).ui.custom((tui: any, theme: any, _kb: any, done: (result: AskUserResult) => void) => {
				let currentTab = 0;
				let optionIndex = 0;
				let inputMode = false;
				let inputQuestionId: string | null = null;
				let inputPurpose: "text" | "custom" | null = null;
				let cachedLines: string[] | undefined;
				let cachedWidth: number | undefined;
				let notice: string | undefined;

				const answers = new Map<string, AskUserAnswer>();
				const skippedIds = new Set<string>();
				const multiSelections = new Map<string, Set<string>>();
				const multiCustomValues = new Map<string, string[]>();

				const editorTheme: EditorTheme = {
					borderColor: (s: string) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t: string) => theme.fg("accent", t),
						selectedText: (t: string) => theme.fg("accent", t),
						description: (t: string) => theme.fg("muted", t),
						scrollInfo: (t: string) => theme.fg("dim", t),
						noMatch: (t: string) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(tui, editorTheme);

				function refresh() {
					cachedLines = undefined;
					cachedWidth = undefined;
					tui.requestRender();
				}

				function submit(cancelled: boolean) {
					done({ title, description, questions, answers: Array.from(answers.values()), cancelled, skippedIds: Array.from(skippedIds) });
				}

				function currentQuestion(): NormalizedQuestion | undefined {
					return questions[currentTab];
				}

				function getQuestionById(id: string): NormalizedQuestion | undefined {
					return questions.find((q) => q.id === id);
				}

				function currentOptions(): ActionOption[] {
					const q = currentQuestion();
					if (!q) return [];
					const opts: ActionOption[] = q.kind === "text"
						? [{ type: "custom", value: "__custom__", label: "Type something.", index: 1 }]
						: q.options.map((opt, i) => ({ ...opt, type: "option", index: i + 1 }));
					if (q.kind !== "text" && q.allowCustom) opts.push({ type: "custom", value: "__custom__", label: "Type something.", index: opts.length + 1 });
					if (q.kind === "multi") {
						for (const value of multiCustomValues.get(q.id) || []) {
							opts.push({ type: "customValue", value, label: value, index: opts.length + 1 });
						}
					}
					if (!q.required) opts.push({ type: "skip", value: "__skip__", label: "Skip", index: opts.length + 1 });
					return opts;
				}

				function preferredOptionIndex(question: NormalizedQuestion | undefined): number {
					if (!question || question.kind === "text") return 0;
					const answer = answers.get(question.id);
					if (!answer) return 0;
					if (answer.wasCustom) {
						return question.allowCustom ? Math.max(0, question.options.length) : 0;
					}
					if (question.kind === "single" && answer.value) {
						const index = question.options.findIndex((opt) => opt.value === answer.value);
						return index >= 0 ? index : 0;
					}
					return 0;
				}

				function prefillInputValue(q: NormalizedQuestion, purpose: "text" | "custom"): string {
					const answer = answers.get(q.id);
					if (!answer) return "";
					if (purpose === "text") return answer.value || answer.label || "";
					if (q.kind === "single" && answer.wasCustom) return answer.value || answer.label || "";
					return "";
				}

				function allResolved(): boolean {
					return questions.every((q) => !q.required || answers.has(q.id));
				}

				function ensureMultiSelection(questionId: string): Set<string> {
					let selected = multiSelections.get(questionId);
					if (!selected) {
						selected = new Set<string>();
						multiSelections.set(questionId, selected);
					}
					return selected;
				}

				function advanceAfterAnswer() {
					notice = undefined;
					if (!isMulti) {
						submit(false);
						return;
					}
					if (currentTab < questions.length - 1) {
						currentTab++;
					} else {
						currentTab = questions.length;
					}
					optionIndex = 0;
					refresh();
				}

				function saveTextAnswer(q: NormalizedQuestion, value: string) {
					skippedIds.delete(q.id);
					multiSelections.delete(q.id);
					multiCustomValues.delete(q.id);
					answers.set(q.id, { id: q.id, kind: q.kind, status: "answered", value, label: value, wasCustom: true });
				}

				function saveSingleAnswer(q: NormalizedQuestion, opt: ActionOption) {
					if (opt.type !== "option") return;
					skippedIds.delete(q.id);
					multiSelections.delete(q.id);
					multiCustomValues.delete(q.id);
					answers.set(q.id, {
						id: q.id,
						kind: q.kind,
						status: "answered",
						value: opt.value,
						label: opt.label,
						wasCustom: false,
						index: opt.index,
					});
				}

				function saveCustomSingleAnswer(q: NormalizedQuestion, value: string) {
					skippedIds.delete(q.id);
					multiSelections.delete(q.id);
					multiCustomValues.delete(q.id);
					answers.set(q.id, {
						id: q.id,
						kind: q.kind,
						status: "answered",
						value,
						label: value,
						wasCustom: true,
						customValues: [value],
					});
				}

				function syncMultiAnswer(q: NormalizedQuestion): boolean {
					const selected = ensureMultiSelection(q.id);
					const customValues = multiCustomValues.get(q.id) || [];
					if (selected.size === 0 && customValues.length === 0) {
						answers.delete(q.id);
						return false;
					}

					skippedIds.delete(q.id);
					const selectedOptions = q.options.filter((opt) => selected.has(opt.value));
					answers.set(q.id, {
						id: q.id,
						kind: q.kind,
						status: "answered",
						values: [...selectedOptions.map((opt) => opt.value), ...customValues],
						labels: [...selectedOptions.map((opt) => opt.label), ...customValues],
						wasCustom: customValues.length > 0,
						customValues,
					});
					return true;
				}

				function setCustomMultiValue(q: NormalizedQuestion, value: string) {
					const values = multiCustomValues.get(q.id) || [];
					if (!values.includes(value)) multiCustomValues.set(q.id, [...values, value]);
					syncMultiAnswer(q);
				}

				function removeCustomMultiValue(q: NormalizedQuestion, value: string) {
					multiCustomValues.set(q.id, (multiCustomValues.get(q.id) || []).filter((item) => item !== value));
					syncMultiAnswer(q);
				}

				function skipQuestion(q: NormalizedQuestion) {
					skippedIds.add(q.id);
					answers.delete(q.id);
					multiSelections.delete(q.id);
					multiCustomValues.delete(q.id);
				}

				for (const q of questions) {
					if (q.defaultValue === undefined) continue;
					const index = q.options.findIndex((option) => option.value === q.defaultValue);
					const option = q.options[index];
					if (index < 0 || !option) continue;
					if (q.kind === "multi") {
						ensureMultiSelection(q.id).add(option.value);
						syncMultiAnswer(q);
					} else {
						saveSingleAnswer(q, { ...option, type: "option", index: index + 1 });
					}
					const answer = answers.get(q.id);
					if (answer) answer.wasDefault = true;
				}

				function saveMultiAnswer(q: NormalizedQuestion): boolean {
					if (!syncMultiAnswer(q)) {
						notice = "Select or type an answer.";
						return false;
					}
					return true;
				}

				function startInput(q: NormalizedQuestion, purpose: "text" | "custom") {
					inputMode = true;
					inputQuestionId = q.id;
					inputPurpose = purpose;
					optionIndex = clampOptionIndex(optionIndex, currentOptions().length);
					editor.setText(prefillInputValue(q, purpose));
					notice = undefined;
					refresh();
				}

				function cancelInput() {
					inputMode = false;
					inputQuestionId = null;
					inputPurpose = null;
					editor.setText("");
					refresh();
				}

				editor.onSubmit = (value: string) => {
					if (!inputQuestionId || !inputPurpose) return;
					const q = getQuestionById(inputQuestionId);
					if (!q) return;

					const trimmed = value.trim();
					if (!trimmed) {
						notice = "Enter something first.";
						refresh();
						return;
					}

					if (inputPurpose === "text") {
						saveTextAnswer(q, trimmed);
					} else if (q.kind === "multi") {
						setCustomMultiValue(q, trimmed);
						cancelInput();
						return;
					} else {
						saveCustomSingleAnswer(q, trimmed);
					}

					cancelInput();
					advanceAfterAnswer();
				};

				function handleInput(data: string) {
					if (inputMode) {
						if (matchesKey(data, Key.escape)) {
							cancelInput();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					if (isMulti) {
						if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
							currentTab = (currentTab + 1) % totalTabs;
							optionIndex = preferredOptionIndex(currentQuestion());
							notice = undefined;
							refresh();
							return;
						}
						if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
							currentTab = (currentTab - 1 + totalTabs) % totalTabs;
							optionIndex = preferredOptionIndex(currentQuestion());
							notice = undefined;
							refresh();
							return;
						}
					}

					if (currentTab === questions.length) {
						if (matchesKey(data, Key.enter)) {
							if (allResolved()) submit(false);
							else {
								notice = "Answer all questions first.";
								refresh();
							}
						} else if (matchesKey(data, Key.escape)) {
							submit(true);
						}
						return;
					}

					const q = currentQuestion();
					if (!q) return;

					if (q.kind === "text") {
						if (matchesKey(data, Key.enter)) {
							if (currentOptions()[optionIndex]?.type === "skip") {
								skipQuestion(q);
								advanceAfterAnswer();
								return;
							}
							startInput(q, "text");
							return;
						}
						if (matchesKey(data, Key.escape)) {
							submit(true);
							return;
						}
						if (!matchesKey(data, Key.up) && !matchesKey(data, Key.down)) {
							startInput(q, "text");
							editor.handleInput(data);
							refresh();
							return;
						}
					}

					const opts = currentOptions();
					optionIndex = clampOptionIndex(optionIndex, opts.length);

					if (matchesKey(data, Key.up) || (q.kind !== "text" && data === "k")) {
						optionIndex = Math.max(0, optionIndex - 1);
						notice = undefined;
						refresh();
						return;
					}
					if (matchesKey(data, Key.down) || (q.kind !== "text" && data === "j")) {
						optionIndex = Math.min(opts.length - 1, optionIndex + 1);
						notice = undefined;
						refresh();
						return;
					}

					const selected = opts[optionIndex];
					if (q.kind === "multi" && (matchesKey(data, Key.space) || data === " ")) {
						if (selected?.type === "option") {
							const selection = ensureMultiSelection(q.id);
							if (selection.has(selected.value)) selection.delete(selected.value);
							else selection.add(selected.value);
							syncMultiAnswer(q);
						} else if (selected?.type === "customValue") {
							removeCustomMultiValue(q, selected.value);
						}
						notice = undefined;
						refresh();
						return;
					}

					if (matchesKey(data, Key.enter)) {
						if (!selected) return;


						if (selected.type === "skip") {
							skipQuestion(q);
							advanceAfterAnswer();
							return;
						}

						if (selected.type === "custom") {
							startInput(q, q.kind === "text" ? "text" : "custom");
							return;
						}

						if (q.kind === "multi") {
							if (saveMultiAnswer(q)) advanceAfterAnswer();
							else refresh();
							return;
						}

						saveSingleAnswer(q, selected);
						advanceAfterAnswer();
						return;
					}

					if (matchesKey(data, Key.escape)) {
						submit(true);
					}
				}

				function render(width: number): string[] {
					if (cachedLines && cachedWidth === width) return cachedLines;

					const lines: string[] = [];
					const q = currentQuestion();
					const opts = currentOptions();
					const add = (s: string) => {
						// Component.render() must return one physical terminal line per array item.
						// Model-provided prompts/descriptions may contain newlines; if we keep those
						// embedded inside a single string, pi undercounts rendered rows and repeated
						// refreshes appear as duplicated/jittery blocks in the terminal.
						const physicalLines = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
						for (const line of physicalLines) {
							lines.push(truncateStyledText(line, width));
						}
					};
					const addWrapped = (prefix: string, text: string) => {
						const prefixWidth = visibleWidth(prefix);
						const chunks = wrapTextWithAnsi(text, Math.max(1, width - prefixWidth));
						for (let i = 0; i < chunks.length; i++) {
							add(`${i === 0 ? prefix : " ".repeat(prefixWidth)}${chunks[i]}`);
						}
					};

					function questionStatus(question: NormalizedQuestion) {
						const answer = answers.get(question.id);
						const isAnswered = !!answer;
						const isSkipped = skippedIds.has(question.id);
						return {
							box: isSkipped ? "–" : answer?.wasDefault ? "◇" : isAnswered ? "■" : !question.required ? "○" : "□",
							color: isSkipped || !question.required ? "dim" : answer?.wasDefault ? "accent" : isAnswered ? "success" : "muted",
						};
					}

					add(theme.fg("accent", "─".repeat(width)));

					if (isMulti) {
						const tabLabels = questions.map((question) => truncatePlainText(question.label, width));
						const tabWidth = 15 + questions.length * 5 + tabLabels.reduce((total, label) => total + visibleWidth(label), 0); // navigation, Submit, boxes, and padding
						if (tabWidth > width) {
							const label = currentTab === questions.length ? "Submit" : currentQuestion()?.label || "";
							const progress = currentTab === questions.length ? "Submit" : `${currentTab + 1}/${questions.length}`;
							add(theme.fg("muted", ` ${progress} ${truncatePlainText(label, Math.max(1, width - visibleWidth(progress) - 2))}`));
						} else {
							const tabs: string[] = ["← "];
							for (let i = 0; i < questions.length; i++) {
								const tabQuestion = questions[i];
								const status = questionStatus(tabQuestion);
								const text = ` ${status.box} ${tabLabels[i]} `;
								const styled = i === currentTab ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(status.color, text);
								tabs.push(`${styled} `);
							}
							const canSubmit = allResolved();
							const submitText = " ✓ Submit ";
							const submitStyled = currentTab === questions.length
								? theme.bg("selectedBg", theme.fg("text", submitText))
								: theme.fg(canSubmit ? "success" : "dim", submitText);
							tabs.push(`${submitStyled} →`);
							add(` ${tabs.join("")}`);
						}
						lines.push("");
					}

					function renderPrompt(question: NormalizedQuestion) {
						addWrapped(" ", theme.fg("text", `${question.prompt}${question.required ? "" : " (optional)"}`));
						if (question.description) addWrapped(" ", theme.fg("muted", question.description));
					}

					function renderTypedAnswer(value: string) {
						const previewLines = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
						for (let i = 0; i < previewLines.length; i++) {
							addWrapped("     ", theme.fg("muted", `${i === 0 ? "↳ " : "  "}${previewLines[i]}`));
						}
					}

					function renderWrappedAnswer(label: string, answer: AskUserAnswer) {
						const source = answer.wasDefault ? theme.fg("muted", "(default) ") : answer.wasCustom ? theme.fg("muted", "(typed) ") : "";
						const prefix = `${theme.fg("muted", ` ${label}: `)}${source}`;
						const availableWidth = Math.max(10, width - 1 - visibleWidth(prefix));
						const rawLines = answerDisplay(answer).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
						let isFirst = true;
						for (const rawLine of rawLines) {
							const wrapped = wrapTextWithAnsi(rawLine, availableWidth);
							const chunks = wrapped.length ? wrapped : [""];
							for (const chunk of chunks) {
								if (isFirst) {
									add(prefix + theme.fg("text", chunk));
									isFirst = false;
								} else {
									add(`${" ".repeat(Math.max(0, visibleWidth(prefix)))}${theme.fg("text", chunk)}`);
								}
							}
						}
					}

					function renderChoiceOptions(question: NormalizedQuestion) {
						const existing = answers.get(question.id);
						for (let i = 0; i < opts.length; i++) {
							const opt = opts[i];
							const selected = i === optionIndex;
							const isOther = opt.type === "custom";
							const isSkipped = opt.type === "skip" && skippedIds.has(question.id);
							const isChosenOption = question.kind === "single" && opt.type === "option" && existing?.value === opt.value && !existing?.wasCustom;
							const isChosenCustom = isOther && !!existing?.wasCustom && (question.kind === "text" || question.kind === "single");
							const prefix = selected ? theme.fg("accent", "> ") : "  ";
							const color = selected ? "accent" : isSkipped ? "dim" : isChosenOption || isChosenCustom ? "success" : "text";
							const chosenSuffix = isSkipped ? theme.fg("dim", " (skipped)") : isChosenOption || isChosenCustom ? theme.fg("success", existing?.wasDefault ? " ✓ (default)" : " ✓") : "";

							if (question.kind === "multi" && opt.type === "option") {
								const isChecked = ensureMultiSelection(question.id).has(opt.value);
								const checked = isChecked ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
								const defaultMark = isChecked && existing?.wasDefault ? theme.fg("muted", " (default)") : "";
								add(prefix + `${checked} ` + theme.fg(color, opt.label) + defaultMark);
							} else if (question.kind === "multi" && opt.type === "customValue") {
								add(prefix + `${theme.fg("success", "[x]")} ` + theme.fg(color, `(typed) ${opt.label}`));
							} else if (question.kind === "text" && isOther && inputMode) {
								add(prefix + theme.fg("accent", `${opt.label} ✎`));
							} else if (question.kind === "text" && isOther) {
								add(prefix + theme.fg(color, opt.label) + chosenSuffix);
							} else if (isOther && inputMode) {
								add(prefix + theme.fg("accent", `${opt.index}. ${opt.label} ✎`));
							} else {
								add(prefix + theme.fg(color, `${opt.index}. ${opt.label}`) + chosenSuffix);
							}

							if (isOther && existing?.wasCustom && !inputMode) {
								renderTypedAnswer(answerDisplay(existing));
							}
							if ("description" in opt && opt.description) {
								addWrapped("     ", theme.fg("muted", opt.description));
							}
						}
					}

					function renderPreviewBlock() {
						const q = currentQuestion();
						if (!q || q.kind !== "single") return;
						const focused = currentOptions()[optionIndex];
						if (!focused || focused.type !== "option" || !focused.preview) return;

						const maxLines = 15;
						const innerWidth = Math.max(1, width - 4);
						const rendered: Array<{ text: string; code: boolean }> = [];
						let inCode = false;
						for (const raw of focused.preview.replace(/\r/g, "").split("\n")) {
							if (raw.trimStart().startsWith("```")) {
								inCode = !inCode;
								continue;
							}
							const wrapped = wrapTextWithAnsi(inCode ? `  ${raw}` : raw, innerWidth);
							for (const text of wrapped.length ? wrapped : [""]) rendered.push({ text, code: inCode });
						}
						if (rendered.length === 0) return;

						function addPreviewLine(text: string) {
							const line = truncateStyledText(text, innerWidth);
							const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
							add(theme.fg("accent", "│ ") + line + padding + theme.fg("accent", " │"));
						}

						const border = "─".repeat(Math.max(0, width - 2));
						lines.push("");
						add(theme.fg("accent", `┌${border}┐`));
						addPreviewLine(theme.fg("muted", "Preview:"));
						for (const { text, code } of rendered.slice(0, maxLines)) {
							addPreviewLine(theme.fg(code ? "dim" : "muted", text));
						}
						const hidden = rendered.length - maxLines;
						if (hidden > 0) addPreviewLine(theme.fg("dim", `… (${hidden} more lines)`));
						add(theme.fg("accent", `└${border}┘`));
					}

					if (inputMode && q) {
						renderPrompt(q);
						lines.push("");
						if ((q.kind as QuestionKind) === "text" || (inputPurpose === "custom" && (q.kind as QuestionKind) !== "text")) {
							renderChoiceOptions(q);
							lines.push("");
						}
						if (inputPurpose === "text") {
							add(theme.fg("muted", " Answer:"));
						}
						for (const line of editor.render(width - 2)) {
							add(` ${line}`);
						}
						lines.push("");
						add(theme.fg("dim", " Enter submit • Esc cancel"));
					} else if (currentTab === questions.length) {
						add(theme.fg("accent", theme.bold(" Answers")));
						lines.push("");
						for (const question of questions) {
							const answer = answers.get(question.id);
							if (answer) {
								renderWrappedAnswer(question.label, answer);
							} else if (skippedIds.has(question.id)) {
								add(theme.fg("dim", ` ${question.label}: (skipped)`));
							}
						}
						lines.push("");
						if (!allResolved()) {
							const missing = questions
								.filter((question) => question.required && !answers.has(question.id))
								.map((question) => question.label)
								.join(", ");
							add(theme.fg("warning", ` Missing: ${missing}`));
						}
					} else if (q) {
						renderPrompt(q);
						lines.push("");
						renderChoiceOptions(q);
						renderPreviewBlock();
					}

					if (notice) {
						lines.push("");
						add(theme.fg("warning", ` ${notice}`));
					}

					lines.push("");
					if (!inputMode) {
						let help: string;
						if (currentTab === questions.length) help = " Enter submit • Esc cancel";
						else if (q?.kind === "text") help = isMulti ? " Tab/←→ switch • Enter/type answer • Esc cancel" : " Enter/type answer • Esc cancel";
						else if (q?.kind === "multi") help = isMulti ? " Tab/←→ switch • ↑↓/jk move • Space toggle/remove • Enter submit • Esc cancel" : " ↑↓/jk move • Space toggle/remove • Enter submit • Esc cancel";
						else help = isMulti ? " Tab/←→ switch • ↑↓/jk move • Enter select • Esc cancel" : " ↑↓/jk move • Enter select • Esc cancel";
						add(theme.fg("dim", help));
					}
					add(theme.fg("accent", "─".repeat(width)));

					cachedLines = lines;
					cachedWidth = width;
					return lines;
				}

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
						cachedWidth = undefined;
					},
					handleInput,
				};
			});

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the questions" }],
					details: result,
				};
			}

			return {
				content: [{ type: "text", text: summarizeResult(result) }],
				details: result,
			};
		},

		renderCall(args: Record<string, unknown>, theme: any) {
			const count = (args.questions as unknown[] | undefined)?.length || 0;
			const rawTitle = typeof args.title === "string" ? args.title : "Ask user";
			const titleHasCount = count > 0 && new RegExp(`${count}\\s*(题|questions?)`, "i").test(rawTitle);
			const title = !titleHasCount && count > 0 ? `${rawTitle}（${count}题）` : rawTitle;
			return new Text(theme.fg("muted", title), 0, 0);
		},

		renderResult(result: Record<string, unknown>, _options: unknown, theme: any) {
			const details = result.details as AskUserResult | undefined;
			if (!details) {
				const text = (result as any).content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", details.error ? `Error: ${details.error}` : "Cancelled"), 0, 0);
			}
			const lines: string[] = [];
			for (const answer of details.answers) {
				const question = details.questions.find((q) => q.id === answer.id);
				const displayName = question?.label || answer.id;
				const source = answer.wasDefault ? theme.fg("muted", "(default) ") : answer.wasCustom ? theme.fg("muted", "(typed) ") : "";
				const prefix = `${theme.fg("success", "✓ ")}${theme.fg("accent", displayName)}: ${source}`;
				const valueLines = answerDisplay(answer).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
				lines.push(prefix + theme.fg("text", valueLines[0] || ""));
				const continuation = " ".repeat(Math.max(0, visibleWidth(prefix)));
				for (const line of valueLines.slice(1)) {
					lines.push(`${continuation}${theme.fg("text", line)}`);
				}
			}
			for (const id of details.skippedIds || []) {
				const question = details.questions.find((q) => q.id === id);
				lines.push(`${theme.fg("dim", "– ")}${theme.fg("accent", question?.label || id)}${theme.fg("dim", ": (skipped)")}`);
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
