import { type Static, Type } from "typebox";
import { Check, Errors } from "typebox/value";

export const QUESTION_KINDS = ["text", "single", "multi"] as const;
export const MAX_QUESTIONS = 5;
export const MIN_CHOICE_OPTIONS = 2;
export const MAX_CHOICE_OPTIONS = 5;
export const MAX_QUESTION_LABEL_LENGTH = 24;
export const MAX_OPTION_LABEL_LENGTH = 120;

/** TypeBox `maxLength` counts code points; mirror that so both validation layers agree. */
function countCodePoints(value: string): number {
	let count = 0;
	for (const _ of value) count++;
	return count;
}
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export interface AskUserOption {
	/** Always present on normalized questions; omitted by callers means "same as label". */
	value: string;
	label: string;
	description?: string;
	preview?: string;
}


export interface NormalizedQuestion {
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

interface AskUserAnswerSource {
	id: string;
	wasCustom?: boolean;
	wasDefault?: boolean;
	customValues?: string[];
}

export interface AskUserTextAnswer extends AskUserAnswerSource {
	kind: "text";
	value: string;
	label: string;
	values?: never;
	labels?: never;
}

export interface AskUserSingleAnswer extends AskUserAnswerSource {
	kind: "single";
	value: string;
	label: string;
	values?: never;
	labels?: never;
}

export interface AskUserMultiAnswer extends AskUserAnswerSource {
	kind: "multi";
	values: string[];
	labels: string[];
	value?: never;
	label?: never;
}

export type AskUserAnswer = AskUserTextAnswer | AskUserSingleAnswer | AskUserMultiAnswer;

export interface AskUserQuestionSummary {
	id: string;
	label: string;
	kind: QuestionKind;
	required: boolean;
}

export interface AskUserResult {
	title: string;
	questions: AskUserQuestionSummary[];
	answers: AskUserAnswer[];
	cancelled: boolean;
	skippedIds?: string[];
	/** Supplementary text, independent of an answer or explicit skip. */
	notes?: Record<string, string>;
	/** Missing required answers, including questions the user explicitly skipped. */
	unresolvedRequiredIds?: string[];
	error?: string;
}

const optionProperties = {
	value: Type.Optional(
		Type.String({ description: "The stable value returned when selected (defaults to the label)" }),
	),
	label: Type.String({
		maxLength: MAX_OPTION_LABEL_LENGTH,
		description: `Display label for the option. Keep it concise; max ${MAX_OPTION_LABEL_LENGTH} characters.`,
	}),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
};

const singleOptionSchema = Type.Object({
	...optionProperties,
	preview: Type.Optional(Type.String({ description: "Optional preview content shown when this option is focused. Use for code snippets, mockups, config examples, or diagrams to help the user compare options visually." })),
}, { additionalProperties: false });

const multiOptionSchema = Type.Object(optionProperties, { additionalProperties: false });

const questionProperties = {
	id: Type.String({ description: "Unique stable identifier for this question" }),
	label: Type.Optional(
		Type.String({
			maxLength: MAX_QUESTION_LABEL_LENGTH,
			description: `Short contextual label for the tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2). Max ${MAX_QUESTION_LABEL_LENGTH} characters.`,
		}),
	),
	prompt: Type.String({ description: "The full question text to display" }),
	description: Type.Optional(Type.String({ description: "Optional explanatory text shown below the prompt" })),
	required: Type.Optional(Type.Boolean({ description: "Whether an answer is needed to resolve the question (default: true). Users can still explicitly skip; skipped required questions remain unresolved, not approved." })),
};

const choiceProperties = {
	allowCustom: Type.Optional(Type.Boolean({ description: "Allow a custom free-text answer for choice questions (default: true)" })),
	defaultValue: Type.Optional(Type.String({ description: "A fixed option value selected by default for single or multi questions" })),
};

const choiceOptions = {
	minItems: MIN_CHOICE_OPTIONS,
	maxItems: MAX_CHOICE_OPTIONS,
	description: `Choice options for single/multi questions. Provide ${MIN_CHOICE_OPTIONS}-${MAX_CHOICE_OPTIONS} options.`,
};

const AskUserQuestionSchema = Type.Union([
	Type.Object({
		...questionProperties,
		kind: Type.Literal("text", { description: "Free-text question" }),
	}, { additionalProperties: false }),
	Type.Object({
		...questionProperties,
		kind: Type.Literal("single", { description: "Select one option or enter a custom answer" }),
		options: Type.Array(singleOptionSchema, choiceOptions),
		...choiceProperties,
	}, { additionalProperties: false }),
	Type.Object({
		...questionProperties,
		kind: Type.Literal("multi", { description: "Select multiple options or enter custom answers" }),
		options: Type.Array(multiOptionSchema, choiceOptions),
		...choiceProperties,
	}, { additionalProperties: false }),
]);

export const AskUserParams = Type.Object({
	title: Type.Optional(Type.String({ description: "Title for the ask-user panel" })),
	questions: Type.Array(AskUserQuestionSchema, {
		minItems: 1,
		maxItems: MAX_QUESTIONS,
		description: `Questions to ask the user. Ask only what is necessary to proceed. Maximum ${MAX_QUESTIONS} questions per call.`,
	}),
}, { additionalProperties: false });

export type AskUserParamsType = Static<typeof AskUserParams>;

type ArgumentError = ReturnType<typeof Errors>[number];

function argumentError(path: string, message: string): string {
	// Keep diagnostics on one line; preserve Unicode and display control characters escaped.
	const displayPath = (path || "/").replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
		(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
	return `Invalid ask_user arguments at ${displayPath}: ${message}`;
}

function propertyPath(path: string, property: string): string {
	return `${path}/${property.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function firstArgumentError(errors: ArgumentError[]): ArgumentError | undefined {
	// TypeBox emits "schema is false" before the actionable additionalProperties error.
	return errors.find((error) => error.keyword !== "boolean") ?? errors[0];
}

function formatArgumentError(error: ArgumentError, prefix = "", kind?: QuestionKind): string {
	let path = `${prefix}${error.instancePath}`;
	let message = error.message;
	if (error.keyword === "required") {
		const property = error.params.requiredProperties[0];
		path = propertyPath(path, property);
		message = property === "options" && kind
			? `${kind} questions require options; provide ${MIN_CHOICE_OPTIONS}-${MAX_CHOICE_OPTIONS} options`
			: `required field; provide ${JSON.stringify(property)}`;
	} else if (error.keyword === "additionalProperties") {
		const property = error.params.additionalProperties[0];
		path = propertyPath(path, property);
		message = "unknown field; remove it";
		if (kind === "text" && error.instancePath === "" && ["options", "allowCustom", "defaultValue"].includes(property)) {
			message = `text questions must not include ${property}`;
		} else if (kind === "multi" && /^\/options\/\d+$/.test(error.instancePath) && property === "preview") {
			message = "preview is supported only for single questions";
		}
	}
	return argumentError(path, message);
}

/** Structural validation only: never coerce, repair, or mutate tool arguments. */
export function validateAskUserArguments(args: unknown): string | undefined {
	if (Check(AskUserParams, args)) return undefined;
	const error = firstArgumentError(Errors(AskUserParams, args));
	// Diagnose only the relevant union branch, using the same schema as strict validation.
	const questionPath = error?.schemaPath.includes("/properties/questions/items/anyOf/")
		? error.instancePath.match(/^\/questions\/(\d+)(?:\/|$)/)
		: undefined;
	if (questionPath && typeof args === "object" && args !== null && "questions" in args && Array.isArray(args.questions)) {
		const prefix = `/questions/${questionPath[1]}`;
		const question: unknown = args.questions[Number(questionPath[1])];
		if (typeof question === "object" && question !== null && !Array.isArray(question)) {
			if (!("kind" in question)) {
				return argumentError(`${prefix}/kind`, 'required field; provide kind as "text", "single", or "multi"');
			}
			const branch = AskUserQuestionSchema.anyOf.find((schema) => schema.properties.kind.const === question.kind);
			if (!branch) {
				return argumentError(`${prefix}/kind`, 'kind must be "text", "single", or "multi"');
			}
			const branchError = firstArgumentError(Errors(branch, question));
			if (branchError) return formatArgumentError(branchError, prefix, branch.properties.kind.const);
		}
	}
	return error ? formatArgumentError(error) : "Invalid ask_user arguments";
}

/** Fill defaults only after structural validation; business validation follows. */
export function normalizeQuestions(params: AskUserParamsType): NormalizedQuestion[] {
	return params.questions.map((q, i) => ({
		id: q.id,
		label: q.label ?? `Q${i + 1}`,
		prompt: q.prompt,
		kind: q.kind,
		description: q.description,
		options: q.kind === "text" ? [] : q.options.map((option) => ({
			...option,
			value: option.value ?? option.label,
		})),
		allowCustom: q.kind === "text" ? true : q.allowCustom !== false,
		required: q.required !== false,
		defaultValue: q.kind === "text" ? undefined : q.defaultValue,
	}));
}

export function summarizeQuestions(questions: readonly NormalizedQuestion[]): AskUserQuestionSummary[] {
	return questions.map(({ id, label, kind, required }) => ({ id, label, kind, required }));
}

export function validateQuestions(questions: readonly NormalizedQuestion[]): string | undefined {
	if (questions.length === 0) return "At least one question is required";
	if (questions.length > MAX_QUESTIONS) return `At most ${MAX_QUESTIONS} questions are allowed per call`;

	const ids = new Set<string>();
	for (const q of questions) {
		if (!q.id.trim()) return "Question id must not be empty";
		if (ids.has(q.id)) return `Duplicate question id: ${q.id}`;
		ids.add(q.id);

		if (!q.prompt.trim()) return `Question '${q.id}' prompt must not be empty`;
		if (!QUESTION_KINDS.includes(q.kind)) return `Question '${q.id}' has invalid kind: ${q.kind}`;
		if (!q.label.trim()) return `Question '${q.id}' label must not be empty`;
		if (countCodePoints(q.label) > MAX_QUESTION_LABEL_LENGTH) {
			return `Question '${q.id}' label exceeds ${MAX_QUESTION_LABEL_LENGTH} characters`;
		}

		if (q.kind === "text") {
			if (q.options.length > 0) return `Question '${q.id}' is text but also provides options`;
			if (q.defaultValue !== undefined) return `Question '${q.id}' is text but provides defaultValue`;
			continue;
		}

		if (q.options.length < MIN_CHOICE_OPTIONS) {
			return `Question '${q.id}' must provide at least ${MIN_CHOICE_OPTIONS} options`;
		}
		if (q.options.length > MAX_CHOICE_OPTIONS) {
			return `Question '${q.id}' exceeds the maximum of ${MAX_CHOICE_OPTIONS} options`;
		}

		const optionValues = new Set<string>();
		const optionLabels = new Set<string>();
		for (const opt of q.options) {
			if (!opt.value.trim()) return `Question '${q.id}' has an option with an empty value`;
			if (!opt.label.trim()) return `Question '${q.id}' has an option with an empty label`;
			if (countCodePoints(opt.label) > MAX_OPTION_LABEL_LENGTH) {
				return `Question '${q.id}' has an option label exceeding ${MAX_OPTION_LABEL_LENGTH} characters`;
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
