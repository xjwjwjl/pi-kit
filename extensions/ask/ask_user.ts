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
const RESERVED_OPTION_LABELS = ["Other", "Type something.", "Chat about this", "Next →"] as const;
type QuestionKind = (typeof QUESTION_KINDS)[number];
type AnswerStatus = "answered";

type ActionOption =
	| (AskUserOption & { type: "option"; index: number })
	| { type: "custom"; value: "__custom__"; label: string; index: number }
	| { type: "chat"; value: "__chat__"; label: string; index: number };

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
	customValues?: string[];
	index?: number;
}

interface AskUserResult {
	title: string;
	description?: string;
	questions: NormalizedQuestion[];
	answers: AskUserAnswer[];
	cancelled: boolean;
	error?: string;
	chatRedirect?: boolean;
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
		const labels = answer.labels || [];
		if (labels.length === 0) return "(none)";
		return `[${labels.map((l) => `"${l}"`).join(", ")}]`;
	}
	const value = answer.label || answer.value || "(empty)";
	return answer.wasCustom ? `"${value}" (typed)` : `"${value}"`;
}

function summarizeResult(result: AskUserResult): string {
	if (result.cancelled) return result.error ? `Question flow failed: ${result.error}` : "User cancelled the questions";
	if (result.chatRedirect) return "User chose to chat about this instead of answering the questions. Continue the conversation.";
	const segments: string[] = [];
	for (const answer of result.answers) {
		const q = result.questions.find((question) => question.id === answer.id);
		const name = q?.label || answer.id;
		segments.push(`"${name}"=${formatAnswerForModel(answer)}`);
	}
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
			"Ask the user concise follow-up questions only when user input is necessary to continue. Supports free text, single choice, multiple choice, and custom answers.",
		promptSnippet:
			`Use ask_user when the user's request is underspecified and you need a small number of focused follow-up questions to continue. Prefer 1-${MAX_QUESTIONS} questions with stable ids, concise labels, and clear options. Do not ask questions whose answers can be inferred or discovered with available tools.`,
		promptGuidelines: [
			"Call ask_user only when user input is genuinely needed to continue with a good answer, design, or implementation.",
			`Ask a small number of focused questions in one call. Prefer 1-${MAX_QUESTIONS} questions and avoid repeated back-to-back ask_user calls when one grouped questionnaire will do.`,
			"Use kind='text' for open-ended answers only when structured options would be premature or too constraining. Omit options entirely for text questions; never send options: [] for text input.",
			`Use kind='single' when exactly one option should be chosen. When providing options, write ${MIN_CHOICE_OPTIONS}-${MAX_CHOICE_OPTIONS} concise, mutually exclusive choices with stable values and short labels (max ${MAX_OPTION_LABEL_LENGTH} characters). Use options[].preview to attach code snippets, config samples, or ASCII diagrams when visual comparison helps the user decide.`,
			`Use kind='multi' only when multiple options may all be valid at the same time. When providing options, write ${MIN_CHOICE_OPTIONS}-${MAX_CHOICE_OPTIONS} concise, non-overlapping choices with stable values and short labels (max ${MAX_OPTION_LABEL_LENGTH} characters). Do not use multi-select for mutually exclusive choices.`, 
			"Do not author reserved labels such as 'Other' or 'Type something.' yourself; the UI adds the custom-answer affordance automatically when allowed.",
		],
		prepareArguments(args: unknown) {
			return prepareAskUserArguments(args);
		},
		parameters: AskUserParams,

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
				let notice: string | undefined;

				const answers = new Map<string, AskUserAnswer>();
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
					tui.requestRender();
				}

				function submit(cancelled: boolean, chatRedirect = false) {
					done({ title, description, questions, answers: Array.from(answers.values()), cancelled, chatRedirect });
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
					if (q.kind === "text") return [
						{ type: "custom", value: "__custom__", label: "Type something.", index: 1 },
						{ type: "chat", value: "__chat__", label: "Chat about this", index: 2 },
					];
					const opts: ActionOption[] = q.options.map((opt, i) => ({ ...opt, type: "option", index: i + 1 }));
					if (q.allowCustom) opts.push({ type: "custom", value: "__custom__", label: "Type something.", index: opts.length + 1 });
					opts.push({ type: "chat", value: "__chat__", label: "Chat about this", index: opts.length + 1 });
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
					if (q.kind === "multi") return (answer.customValues && answer.customValues[0]) || (multiCustomValues.get(q.id) || [])[0] || "";
					return "";
				}

				function allResolved(): boolean {
					return questions.every((q) => answers.has(q.id));
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
					multiSelections.delete(q.id);
					multiCustomValues.delete(q.id);
					answers.set(q.id, { id: q.id, kind: q.kind, status: "answered", value, label: value, wasCustom: true });
				}

				function saveSingleAnswer(q: NormalizedQuestion, opt: ActionOption) {
					if (opt.type !== "option") return;
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
					multiCustomValues.set(q.id, [value]);
					syncMultiAnswer(q);
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
						advanceAfterAnswer();
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
							if (optionIndex > 0) { submit(false, true); return; }
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

					if (matchesKey(data, Key.up)) {
						optionIndex = Math.max(0, optionIndex - 1);
						notice = undefined;
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
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
							notice = undefined;
							refresh();
						}
						return;
					}

					if (matchesKey(data, Key.enter)) {
						if (!selected) return;

						if (selected.type === "chat") {
							submit(false, true);
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
					if (cachedLines) return cachedLines;

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
							lines.push(truncateToWidth(line, width));
						}
					};

					add(theme.fg("accent", "─".repeat(width)));

					if (isMulti) {
						const tabs: string[] = ["← "];
						const tabLabelWidth = 10;
						for (let i = 0; i < questions.length; i++) {
							const tabQuestion = questions[i];
							const isActive = i === currentTab;
							const isAnswered = answers.has(tabQuestion.id);
							const box = isAnswered ? "■" : "□";
							const color = isAnswered ? "success" : "muted";
							const label = truncateToWidth(tabQuestion.label, tabLabelWidth, "…");
							const text = ` ${box} ${label} `;
							const styled = isActive ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(color, text);
							tabs.push(`${styled} `);
						}
						const canSubmit = allResolved();
						const isSubmitTab = currentTab === questions.length;
						const submitText = " ✓ Submit ";
						const submitStyled = isSubmitTab
							? theme.bg("selectedBg", theme.fg("text", submitText))
							: theme.fg(canSubmit ? "success" : "dim", submitText);
						tabs.push(`${submitStyled} →`);
						add(` ${tabs.join("")}`);
						lines.push("");
					}

					function renderPrompt(question: NormalizedQuestion) {
						add(theme.fg("text", ` ${question.prompt}`));
						if (question.description) add(theme.fg("muted", ` ${question.description}`));
					}

					function renderAnswerPreview(value: string) {
						const previewLines = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
						for (let i = 0; i < previewLines.length; i++) {
							const marker = i === 0 ? theme.fg("dim", "· ") : "  ";
							add(`     ${marker}${theme.fg("muted", previewLines[i])}`);
						}
					}

					function renderWrappedAnswer(label: string, answer: AskUserAnswer) {
						const custom = answer.wasCustom ? theme.fg("muted", "(typed) ") : "";
						const prefix = `${theme.fg("muted", ` ${label}: `)}${custom}`;
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
							const isChosenOption = question.kind === "single" && opt.type === "option" && existing?.value === opt.value && !existing?.wasCustom;
							const isChosenCustom = isOther && !!existing?.wasCustom && (question.kind === "text" || question.kind === "single");
							const prefix = selected ? theme.fg("accent", "> ") : "  ";
							const color = selected ? "accent" : isChosenOption || isChosenCustom ? "success" : "text";
							const chosenSuffix = isChosenOption || isChosenCustom ? theme.fg("success", " ✓") : "";

							if (question.kind === "multi" && opt.type === "option") {
								const checked = ensureMultiSelection(question.id).has(opt.value) ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
								add(prefix + `${checked} ` + theme.fg(color, opt.label));
							} else if (question.kind === "text" && isOther && inputMode) {
								add(prefix + theme.fg("accent", `${opt.label} ✎`));
							} else if (question.kind === "text" && isOther) {
								add(prefix + theme.fg(color, opt.label) + chosenSuffix);
							} else if (isOther && inputMode) {
								add(prefix + theme.fg("accent", `${opt.index}. ${opt.label} ✎`));
							} else {
								add(prefix + theme.fg(color, `${opt.index}. ${opt.label}`) + chosenSuffix);
							}

							if ("description" in opt && opt.description) {
								add(`     ${theme.fg("muted", opt.description)}`);
							}
						}

						if (question.kind === "multi") {
							const customValues = multiCustomValues.get(question.id) || [];
							if (customValues.length) {
								renderAnswerPreview(customValues.join(", "));
							}
						} else if (question.kind === "text" && existing) {
							renderAnswerPreview(answerDisplay(existing));
						} else if (question.kind === "single" && existing?.wasCustom) {
							renderAnswerPreview(answerDisplay(existing));
						}
					}

					function renderPreviewBlock() {
						const q = currentQuestion();
						if (!q || q.kind !== "single") return;
						const opts = currentOptions();
						const focused = opts[optionIndex];
						if (!focused || focused.type !== "option") return;
						const { preview } = focused as { preview?: string };
						if (!preview) return;

						const maxLines = 15;
						const innerWidth = Math.max(20, width - 6);
						const rawLines = preview.replace(/\r/g, "").split("\n");

						let inCode = false;
						const rendered: string[] = [];
						for (const raw of rawLines.slice(0, maxLines)) {
							if (raw.trimStart().startsWith("```")) {
								inCode = !inCode;
								continue;
							}
							const line = truncateToWidth(inCode ? `  ${raw}` : raw, innerWidth);
							rendered.push(inCode ? theme.fg("dim", ` │ ${line}`) : theme.fg("muted", ` ${line}`));
						}
						if (rawLines.length > maxLines) {
							rendered.push(theme.fg("dim", ` … (${rawLines.length - maxLines} more lines)`));
						}
						if (rendered.length === 0) return;

						const border = "─".repeat(Math.max(1, width - 2));
						lines.push("");
						add(theme.fg("accent", `┌${border}┐`));
						add(theme.fg("muted", "│ Preview:" + " ".repeat(Math.max(0, width - 11)) + "│"));
						for (const line of rendered) {
							add(line);
						}
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
							}
						}
						lines.push("");
						if (!allResolved()) {
							const missing = questions
								.filter((question) => !answers.has(question.id))
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
						else if (q?.kind === "multi") help = isMulti ? " Tab/←→ switch • ↑↓ move • Space toggle • Enter submit • Esc cancel" : " ↑↓ move • Space toggle • Enter submit • Esc cancel";
						else help = isMulti ? " Tab/←→ switch • ↑↓ move • Enter select • Esc cancel" : " ↑↓ move • Enter select • Esc cancel";
						add(theme.fg("dim", help));
					}
					add(theme.fg("accent", "─".repeat(width)));

					cachedLines = lines;
					return lines;
				}

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
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
			const qs = (args.questions as Array<{ id?: string; label?: string }> | undefined) || [];
			const count = qs.length;
			const labels = qs.map((q, i) => q.label || q.id || `Q${i + 1}`);
			const rawTitle = typeof args.title === "string" ? args.title : "Ask user";
			const titleHasCount = count > 0 && new RegExp(`${count}\\s*(题|questions?)`, "i").test(rawTitle);
			const genericLabels = labels.length > 0 && labels.every((label, i) => label === `Q${i + 1}`);
			const title = !titleHasCount && count > 0 ? `${rawTitle}（${count}题）` : rawTitle;
			let text = theme.fg("muted", title);
			if (labels.length && !genericLabels) {
				const previewCount = Math.min(5, labels.length);
				const preview = labels.slice(0, previewCount).map((label) => truncateToWidth(label, 12, "…"));
				const remaining = labels.length - previewCount;
				text += theme.fg("dim", ` (${preview.join(", ")}${remaining > 0 ? `, +${remaining} more` : ""})`);
			}
			return new Text(text, 0, 0);
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
			if (details.chatRedirect) {
				return new Text(theme.fg("accent", "💬 Chat about this — continuing conversation"), 0, 0);
			}

			const lines: string[] = [];
			for (const answer of details.answers) {
				const question = details.questions.find((q) => q.id === answer.id);
				const displayName = question?.label || answer.id;
				const custom = answer.wasCustom ? theme.fg("muted", "(typed) ") : "";
				const prefix = `${theme.fg("success", "✓ ")}${theme.fg("accent", displayName)}: ${custom}`;
				const valueLines = answerDisplay(answer).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
				lines.push(prefix + theme.fg("text", valueLines[0] || ""));
				const continuation = " ".repeat(Math.max(0, visibleWidth(prefix)));
				for (const line of valueLines.slice(1)) {
					lines.push(`${continuation}${theme.fg("text", line)}`);
				}
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
