import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeLabel, sanitizeMultilineText } from "./src/tabs.ts";
import { createQuestionnaire } from "./src/component.ts";
import { answerDisplay, makeErrorResult, makeCancelledResult, summarizeResult } from "./src/format.ts";
import { answerSourceLabel, UI_TEXT, unresolvedWarning } from "./src/ui-copy.ts";
import {
	AskUserParams, type AskUserParamsType, type AskUserResult,
	MAX_QUESTIONS, MIN_CHOICE_OPTIONS, MAX_CHOICE_OPTIONS, MAX_OPTION_LABEL_LENGTH,
	normalizeQuestions, validateAskUserArguments, validateQuestions,
} from "./src/schema.ts";

export default function askUser(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user concise follow-up questions in interactive TUI mode when user input is necessary to continue. Supports free text, single/multiple choice, custom answers, per-question notes, and explicit skips.",
		promptSnippet:
			`Use ask_user only in interactive TUI when a user decision, preference, or approval is required and cannot be inferred from context or discovered with tools. Batch related questions (up to ${MAX_QUESTIONS}). Do not use it for status updates, quizzes, or information already available.`,
		promptGuidelines: [
			"Outside interactive TUI mode, do not call ask_user; state the limitation or proceed with a safe explicit assumption.",
			"Top-level fields are title and questions only. Put necessary context in the relevant questions[].prompt or questions[].description; keep the title concise. Supply stable question IDs and option values explicitly.",
			"Always specify kind. Use kind='text' for open-ended answers only when structured options would be premature or too constraining. Text questions must omit options, allowCustom and defaultValue.",
			`Use kind='single' when exactly one option should be chosen. Always provide ${MIN_CHOICE_OPTIONS}-${MAX_CHOICE_OPTIONS} concise, mutually exclusive choices with short labels (max ${MAX_OPTION_LABEL_LENGTH} characters); options[].value is optional and defaults to the label. Use options[].preview to attach concise code snippets, config samples, or ASCII diagrams when visual comparison helps the user decide; use short excerpts rather than entire files.`,
			`Use kind='multi' only when multiple options may all be valid at the same time. Always provide ${MIN_CHOICE_OPTIONS}-${MAX_CHOICE_OPTIONS} concise, non-overlapping choices with short labels (max ${MAX_OPTION_LABEL_LENGTH} characters); options[].value is optional and defaults to the label. Do not use multi-select for mutually exclusive choices; options[].preview is single-select only.`,
			"Use required: false only when an unanswered question does not block the task. Users may explicitly skip any question; required skips remain unresolved. Never treat a skip or a supplementary note by itself as approval, and do not perform actions that depend on an unanswered required decision.",
			"Set defaultValue only for a reusable preference the user already stated; it must match an existing option value and must not bypass a new decision. Supplementary notes are independent context, not replacement option values.",
			"The UI supplies its own note and submit controls; do not add duplicate control options for them.",
		],
		prepareArguments(args: unknown) {
			// The host otherwise converts primitive types before schema validation.
			// Reject invalid raw input here; never repair, coerce, or drop fields.
			const error = validateAskUserArguments(args);
			if (error) throw new TypeError(error);
			return args as AskUserParamsType;
		},
		parameters: AskUserParams,
		exposure: "model-only",
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const title = typeof params?.title === "string" && params.title ? params.title : UI_TEXT.defaultTitle;
			const mode = typeof ctx.mode === "string" ? ctx.mode : undefined;

			if (mode !== "tui") {
				const error = ctx.hasUI === true ? `ask_user requires interactive TUI mode (current mode: ${mode || "unknown"})` : "UI not available";
				return makeErrorResult(error, { title });
			}

			const argumentError = validateAskUserArguments(params);
			if (argumentError) return makeErrorResult(argumentError, { title });

			const questions = normalizeQuestions(params);
			const validationError = validateQuestions(questions);
			if (validationError) {
				return makeErrorResult(validationError, { title, questions });
			}

			if (signal?.aborted) return makeCancelledResult({ title, questions });

			// The host may reject the factory or resolve without ever calling `done`;
			// both must surface as structured errors, not as an uncaught throw.
			let result: AskUserResult;
			try {
				result = await ctx.ui.custom<AskUserResult>(
					(tui, theme, keybindings, done) => createQuestionnaire(tui, theme, keybindings, { title, questions, signal }, done),
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return makeErrorResult(`questionnaire UI failed: ${message}`, { title, questions });
			}
			if (!result || typeof result !== "object" || !Array.isArray(result.answers)) {
				return makeErrorResult("questionnaire UI closed without a result", { title, questions });
			}

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

		renderCall(args, theme) {
			const count = args.questions?.length || 0;
			const rawTitle = typeof args.title === "string" && args.title ? args.title : UI_TEXT.defaultTitle;
			// Require a digit boundary so "21 questions" is not read as an existing "1题" count.
			const titleHasCount = count > 0 && new RegExp(`(?:^|[^0-9])${count}\\s*(题|questions?)`, "i").test(rawTitle);
			const title = sanitizeLabel(!titleHasCount && count > 0 ? `${rawTitle}（${count}题）` : rawTitle);
			return new Text(theme.fg("muted", title), 0, 0);
		},

		renderResult(result, _options, theme) {
			// The host answers a prepareArguments/execute throw with `details: {}`; never
			// assume the full result shape here.
			const details = result.details as Partial<AskUserResult> | undefined;
			const answers = Array.isArray(details?.answers) ? details.answers : undefined;
			if (!details || !answers) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? sanitizeMultilineText(text.text) : "", 0, 0);
			}
			const questions = Array.isArray(details.questions) ? details.questions : [];
			const questionLabel = (id: string) => sanitizeLabel(questions.find((q) => q.id === id)?.label || id);
			const unresolved = Array.isArray(details.unresolvedRequiredIds) ? details.unresolvedRequiredIds : [];

			if (details.error !== undefined) {
				const lines = [theme.fg("warning", sanitizeMultilineText(`${UI_TEXT.errorPrefix}${details.error}`))];
				if (unresolved.length) lines.push(theme.fg("warning", unresolvedWarning(unresolved)));
				return new Text(lines.join("\n"), 0, 0);
			}
			if (details.cancelled) {
				const lines = [theme.fg("warning", UI_TEXT.cancelled)];
				if (unresolved.length) lines.push(theme.fg("warning", unresolvedWarning(unresolved)));
				return new Text(lines.join("\n"), 0, 0);
			}

			const lines: string[] = [];
			const addValue = (prefix: string, value: string) => {
				const valueLines = sanitizeMultilineText(value).split("\n");
				lines.push(prefix + theme.fg("text", valueLines[0] || ""));
				const continuation = " ".repeat(Math.max(0, visibleWidth(prefix)));
				for (const line of valueLines.slice(1)) lines.push(`${continuation}${theme.fg("text", line)}`);
			};
			for (const answer of answers) {
				const displayName = questionLabel(answer.id);
				const source = answerSourceLabel(answer);
				const prefix = `${theme.fg("success", "✓ ")}${theme.fg("accent", displayName)}: ${source ? theme.fg("muted", source + " ") : ""}`;
				addValue(prefix, answerDisplay(answer));
			}
			for (const id of details.skippedIds || []) {
				const displayName = questionLabel(id);
				const required = questions.find((q) => q.id === id)?.required === true;
				const status = `: ${required ? UI_TEXT.skippedRequired : UI_TEXT.skipped}`;
				lines.push(`${theme.fg("dim", "– ")}${theme.fg("accent", displayName)}${theme.fg(required ? "warning" : "dim", status)}`);
			}
			for (const [id, note] of Object.entries(details.notes || {})) {
				addValue(`${theme.fg("accent", questionLabel(id))}${theme.fg("muted", " " + UI_TEXT.notePrefix)}`, note);
			}
			if (unresolved.length) {
				lines.push(theme.fg("warning", unresolvedWarning(unresolved)));
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
