import { summarizeQuestions, type AskUserAnswer, type AskUserResult, type NormalizedQuestion } from "./schema.ts";
import { UI_TEXT } from "./ui-copy.ts";

interface EarlyResultOptions {
	title?: string;
	questions?: readonly NormalizedQuestion[];
}

function earlyResult(
	{ title = UI_TEXT.defaultTitle, questions = [] }: EarlyResultOptions,
	error?: string,
): { content: { type: "text"; text: string }[]; details: AskUserResult; isError?: boolean } {
	// Only a real cancellation is `cancelled`; an error keeps the snapshot shape but
	// must never be consumed as "the user cancelled".
	const cancelled = error === undefined;
	return {
		content: [{ type: "text", text: !cancelled ? `Error: ${error}` : "User cancelled the questions" }],
		details: {
			title,
			questions: summarizeQuestions(questions),
			answers: [],
			cancelled,
			skippedIds: [],
			notes: {},
			unresolvedRequiredIds: questions.filter((question) => question.required).map((question) => question.id),
			error,
		},
		...(!cancelled ? { isError: true } : {}),
	};
}

export function makeErrorResult(error: string, options: EarlyResultOptions = {}) {
	return earlyResult(options, error);
}

export function makeCancelledResult(options: EarlyResultOptions = {}) {
	return earlyResult(options);
}

export function answerDisplay(answer: AskUserAnswer): string {
	if (answer.kind === "multi") {
		const labels = answer.labels;
		return labels.length ? labels.join(", ") : UI_TEXT.emptySelection;
	}
	return answer.label || answer.value || UI_TEXT.emptyAnswer;
}

function formatAnswerForModel(answer: AskUserAnswer): string {
	if (answer.kind === "multi") {
		const values = answer.values;
		if (values.length === 0) return "(none)";
		return JSON.stringify({ values, labels: answer.labels, typed: answer.wasCustom || undefined, default: answer.wasDefault || undefined });
	}
	const value = answer.value || answer.label || "(empty)";
	return JSON.stringify({ value, label: answer.label || value, typed: answer.wasCustom || undefined, default: answer.wasDefault || undefined });
}

export function summarizeResult(result: AskUserResult): string {
	if (result.error !== undefined) return `Question flow failed: ${result.error}`;
	if (result.cancelled) {
		const unresolvedOnCancel = result.unresolvedRequiredIds ?? [];
		const cancelledNote = unresolvedOnCancel.length
			? ` Unresolved required questions: ${JSON.stringify(unresolvedOnCancel)}. A cancellation is not approval; do not proceed with actions that depend on those decisions.`
			: "";
		return `User cancelled the questions.${cancelledNote}`;
	}
	const segments: string[] = [];
	for (const answer of result.answers) {
		const q = result.questions.find((question) => question.id === answer.id);
		segments.push(`${answer.id}=${formatAnswerForModel(answer)} (label: ${JSON.stringify(q?.label || answer.id)})`);
	}
	if (result.skippedIds?.length) segments.push(`skipped=${JSON.stringify(result.skippedIds)}`);
	if (result.notes && Object.keys(result.notes).length) segments.push(`notes=${JSON.stringify(result.notes)}`);
	const answeredIds = new Set(result.answers.map((answer) => answer.id));
	const unresolved = result.questions.filter((question) => question.required && !answeredIds.has(question.id)).map((question) => question.id);
	if (unresolved.length) segments.push(`unresolvedRequiredIds=${JSON.stringify(unresolved)}`);
	if (segments.length === 0) return "User did not answer any questions.";
	const guidance = unresolved.length
		? "Required questions remain unresolved. Skips and supplementary notes are not approval; do not proceed with actions that depend on those unanswered decisions."
		: "Use the answers and supplementary notes as context. A skipped question is not approval.";
	return `User responses: ${segments.join(". ")}. ${guidance}`;
}
