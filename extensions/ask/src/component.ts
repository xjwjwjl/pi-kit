import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, decodeKittyPrintable, Editor, type EditorTheme, type TUI, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { answerDisplay } from "./format.ts";
import { summarizeQuestions, type AskUserOption, type AskUserAnswer, type AskUserResult, type NormalizedQuestion } from "./schema.ts";
import { type LineRange, getInlineMaxHeight, resolveViewport } from "./viewport.ts";
import { resolveInlineLayout } from "./inline-layout.ts";
import { PreviewLayoutCache } from "./preview.ts";
import { renderTabBar, sanitizeLabel } from "./tabs.ts";
import { type AuxiliaryAction, renderAuxiliaryActions } from "./auxiliary-actions.ts";
import { answerSourceLabel, UI_TEXT } from "./ui-copy.ts";

const ANSI_RESET = "\x1b[0m";
const MIN_FRAMED_HEIGHT = 8;

function truncatePlainText(text: string, width: number, ellipsis = "…"): string {
	return truncateToWidth(text.replace(/[\x00-\x1f\x7f-\x9f]/g, ""), width, ellipsis).replaceAll(ANSI_RESET, "");
}

function truncateStyledText(text: string, width: number, ellipsis = "..."): string {
	if (width <= visibleWidth(ellipsis)) return truncateToWidth(text, width, "");
	const truncated = truncateToWidth(text, width, ellipsis);
	const suffix = `${ANSI_RESET}${ellipsis}${ANSI_RESET}`;
	return truncated.endsWith(suffix) ? `${truncated.slice(0, -suffix.length)}${ellipsis}${ANSI_RESET}` : truncated;
}

// Pi's key matcher rejects every modified function key, and kitty/xterm disagree on
// the Shift+F6 byte sequence, so both spellings are matched explicitly here.
const SHIFT_F6_SEQUENCES = ["\x1b[17;2~", "\x1b[17;2u", "\x1b[27;2;17~"];

function isShiftF6(data: string): boolean {
	return matchesKey(data, Key.shift("f6")) || SHIFT_F6_SEQUENCES.includes(data);
}

// Kitty reports plain letters as CSI-u sequences; anything escape-prefixed that is
// not a printable kitty sequence is a key press, not typed text.
function isTypedText(data: string): boolean {
	if (decodeKittyPrintable(data) !== undefined) return true;
	return !data.startsWith("\x1b");
}

type InputPurpose = "text" | "custom" | "note";

type ChoiceOption =
	| (AskUserOption & { type: "option"; index: number })
	| { type: "custom"; value: "__custom__"; label: string; index: number }
	| { type: "customValue"; value: string; label: string; index: number };

function clampOptionIndex(index: number, count: number): number {
	if (count <= 0) return 0;
	return Math.max(0, Math.min(count - 1, index));
}

interface QuestionnaireOptions {
	title: string;
	questions: NormalizedQuestion[];
	signal?: AbortSignal;
}

export interface KeybindingsLike {
	matches(data: string, keybinding: string): boolean;
}

export function createQuestionnaire(
	tui: TUI,
	theme: Theme,
	kb: KeybindingsLike | undefined,
	{ title, questions, signal }: QuestionnaireOptions,
	done: (result: AskUserResult) => void,
) {
	const isMulti = questions.length > 1;
	// Single-question flows have no review page, matching Pi's questionnaire demo.
	const totalTabs = isMulti ? questions.length + 1 : 1;
	const titleLabel = sanitizeLabel(title);
	let closed = false;
	let focused = false;
	let currentTab = 0;
	let optionIndex = 0;
	let focusedAction: AuxiliaryAction | undefined;
	let inputMode = false;
	let inputQuestionId: string | null = null;
	let inputPurpose: InputPurpose | null = null;
	let cachedLines: string[] | undefined;
	let cachedWidth: number | undefined;
	let cachedRows: number | undefined;
	let cachedLayoutKey: string | undefined;
	let cachedRequestedHeight = 3;
	let layoutWidth = 0;
	let layoutRows = 0;
	let viewportOffset = 0;
	let viewportHeight = 1;
	let bodyLineCount = 0;
	let followFocus = true;
	let notice: string | undefined;

	const answers = new Map<string, AskUserAnswer>();
	const skippedIds = new Set<string>();
	const notes = new Map<string, string>();
	const expandedPreviews = new Set<string>();
	const multiSelections = new Map<string, Set<string>>();
	const multiCustomValues = new Map<string, string[]>();
	const previewLayouts = new PreviewLayoutCache();

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

	// Host keybindings are honored on top of the documented defaults: a rebound
	// key keeps working, and the default key still works as a fallback.
	function bound(data: string, keybinding: string): boolean {
		try {
			return kb?.matches?.(data, keybinding) === true;
		} catch {
			return false;
		}
	}

	const isConfirm = (data: string) => matchesKey(data, Key.enter) || bound(data, "tui.select.confirm");
	const isCancel = (data: string) => matchesKey(data, Key.escape) || bound(data, "tui.select.cancel");
	const isAnswerUp = (data: string) => matchesKey(data, Key.up) || bound(data, "tui.select.up");
	const isAnswerDown = (data: string) => matchesKey(data, Key.down) || bound(data, "tui.select.down");

	function refresh(revealFocus = true) {
		cachedLines = undefined;
		followFocus = revealFocus;
		tui.requestRender();
	}

	function submit(cancelled: boolean) {
		if (closed) return;
		closed = true;
		editor.focused = false;
		signal?.removeEventListener("abort", onAbort);
		done({
			title, questions: summarizeQuestions(questions),
			answers: questions.flatMap((q) => {
				const answer = answers.get(q.id);
				return answer ? [answer] : [];
			}), cancelled,
			skippedIds: Array.from(skippedIds), notes: Object.fromEntries(notes),
			unresolvedRequiredIds: questions.filter((q) => q.required && !answers.has(q.id)).map((q) => q.id),
		});
	}

	function onAbort() {
		submit(true);
	}

	function currentQuestion(): NormalizedQuestion | undefined {
		return questions[currentTab];
	}

	function getQuestionById(id: string): NormalizedQuestion | undefined {
		return questions.find((q) => q.id === id);
	}

	function previewOption(q: NormalizedQuestion): AskUserOption | undefined {
		return q.kind === "single" ? q.options[optionIndex] : undefined;
	}

	function currentOptions(): ChoiceOption[] {
		const q = currentQuestion();
		if (!q) return [];
		const opts: ChoiceOption[] = q.kind === "text"
			? [{ type: "custom", value: "__custom__", label: UI_TEXT.customAnswer, index: 1 }]
			: q.options.map((opt, i) => ({ ...opt, type: "option", index: i + 1 }));
		if (q.kind !== "text" && q.allowCustom) opts.push({ type: "custom", value: "__custom__", label: UI_TEXT.customAnswer, index: opts.length + 1 });
		if (q.kind === "multi") {
			for (const value of multiCustomValues.get(q.id) || []) {
				opts.push({ type: "customValue", value, label: value, index: opts.length + 1 });
			}
		}
		return opts;
	}

	function preferredOptionIndex(question: NormalizedQuestion | undefined): number {
		if (!question) return 0;
		if (question.kind === "text") return 0;
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

	function prefillInputValue(q: NormalizedQuestion, purpose: InputPurpose): string {
		if (purpose === "note") return notes.get(q.id) || "";
		const answer = answers.get(q.id);
		if (!answer) return "";
		if (purpose === "text") return answer.value || answer.label || "";
		if (q.kind === "single" && answer.wasCustom) return answer.value || answer.label || "";
		return "";
	}

	function pendingQuestions(): NormalizedQuestion[] {
		return questions.filter((q) => q.required && !answers.has(q.id) && !skippedIds.has(q.id));
	}

	function switchTab(index: number) {
		currentTab = index;
		focusedAction = undefined;
		viewportOffset = 0;
		optionIndex = preferredOptionIndex(currentQuestion());
		notice = undefined;
		refresh();
	}

	// Enter confirms an answer and moves on. Answering the last question lands on
	// the review page, exactly like Pi's questionnaire demo, so the next Enter is
	// the explicit submission rather than another answer confirmation. A
	// single-question flow has no review page, so confirming is the submission.
	function advanceAfterAnswer() {
		if (!isMulti) {
			submit(false);
			return;
		}
		if (currentTab < questions.length - 1) {
			switchTab(currentTab + 1);
			return;
		}
		switchTab(questions.length);
	}

	function ensureMultiSelection(questionId: string): Set<string> {
		let selected = multiSelections.get(questionId);
		if (!selected) {
			selected = new Set<string>();
			multiSelections.set(questionId, selected);
		}
		return selected;
	}

	function saveTextAnswer(q: NormalizedQuestion, value: string) {
		skippedIds.delete(q.id);
		multiSelections.delete(q.id);
		multiCustomValues.delete(q.id);
		answers.set(q.id, { id: q.id, kind: "text", value, label: value, wasCustom: true });
	}

	function saveSingleAnswer(q: NormalizedQuestion, opt: ChoiceOption) {
		if (opt.type !== "option") return;
		const previous = answers.get(q.id);
		// Re-confirming the seeded default must not erase its provenance.
		const wasDefault = previous?.wasDefault === true && previous.kind === "single"
			&& !previous.wasCustom && previous.value === opt.value;
		skippedIds.delete(q.id);
		multiSelections.delete(q.id);
		multiCustomValues.delete(q.id);
		answers.set(q.id, {
			id: q.id,
			kind: "single",
			value: opt.value,
			label: opt.label,
			wasCustom: false,
			...(wasDefault ? { wasDefault: true } : {}),
		});
	}

	function saveCustomSingleAnswer(q: NormalizedQuestion, value: string) {
		skippedIds.delete(q.id);
		multiSelections.delete(q.id);
		multiCustomValues.delete(q.id);
		answers.set(q.id, {
			id: q.id,
			kind: "single",
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
		const values = [...selectedOptions.map((opt) => opt.value), ...customValues];
		const previous = answers.get(q.id);
		const previousValues = previous?.values ?? [];
		// Provenance survives only while the selection still matches the seeded default.
		const wasDefault = previous?.wasDefault === true && customValues.length === 0
			&& previousValues.length === values.length && values.every((value) => previousValues.includes(value));
		answers.set(q.id, {
			id: q.id,
			kind: "multi",
			values,
			labels: [...selectedOptions.map((opt) => opt.label), ...customValues],
			wasCustom: customValues.length > 0,
			customValues,
			...(wasDefault ? { wasDefault: true } : {}),
		});
		return true;
	}

	function setCustomMultiValue(q: NormalizedQuestion, value: string) {
		const values = multiCustomValues.get(q.id) || [];
		if (!values.includes(value)) multiCustomValues.set(q.id, [...values, value]);
		syncMultiAnswer(q);
		// Land on the value that was just created, so Enter finishes the question instead
		// of reopening an empty custom editor.
		const created = currentOptions().findIndex((option) => option.type === "customValue" && option.value === value);
		if (created >= 0) optionIndex = created;
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

	optionIndex = preferredOptionIndex(currentQuestion());

	function startInput(q: NormalizedQuestion, purpose: InputPurpose) {
		inputMode = true;
		editor.focused = focused;
		inputQuestionId = q.id;
		inputPurpose = purpose;
		optionIndex = clampOptionIndex(optionIndex, currentOptions().length);
		editor.setText(prefillInputValue(q, purpose));
		notice = undefined;
		refresh();
	}

	function activateAuxiliaryAction(q: NormalizedQuestion, action: AuxiliaryAction) {
		if (action === "note") {
			startInput(q, "note");
			return;
		}
		// Skip has no meaning in a single-question flow: there is no later question to
		// see the skipped topic in, so cancelling is the only way out without answering.
		if (!isMulti) return;
		skipQuestion(q);
		optionIndex = preferredOptionIndex(q);
		notice = undefined;
		viewportOffset = 0;
		refresh();
	}

	// Focus ring: every answer option first, then the auxiliary controls, wrapping
	// back to the first option. F6 skips straight to the auxiliary row instead.
	function cycleFocus(step: 1 | -1) {
		const q = currentQuestion();
		if (!q) return;
		const count = currentOptions().length;
		const ring: (number | AuxiliaryAction)[] = Array.from({ length: count }, (_, index) => index);
		ring.push("note");
		if (isMulti) ring.push("skip");
		const current = focusedAction ?? optionIndex;
		const position = ring.indexOf(current);
		const next = position < 0 ? 0 : (position + step + ring.length) % ring.length;
		const target = ring[next];
		if (typeof target === "number") {
			focusedAction = undefined;
			optionIndex = clampOptionIndex(target, count);
			return;
		}
		focusedAction = target;
	}

	function cancelInput() {
		inputMode = false;
		editor.focused = false;
		inputQuestionId = null;
		inputPurpose = null;
		editor.setText("");
		notice = undefined;
		refresh();
	}

	editor.onSubmit = (value: string) => {
		if (!inputQuestionId || !inputPurpose) return;
		const q = getQuestionById(inputQuestionId);
		if (!q) return;

		const trimmed = value.trim();
		let advance = false;
		if (inputPurpose === "note") {
			if (trimmed) notes.set(q.id, trimmed);
			else notes.delete(q.id);
		} else {
			if (!trimmed) {
				notice = UI_TEXT.emptyInput;
				refresh();
				return;
			}
			if (inputPurpose === "text") {
				saveTextAnswer(q, trimmed);
				advance = true;
			} else if (q.kind === "multi") {
				setCustomMultiValue(q, trimmed);
			} else {
				saveCustomSingleAnswer(q, trimmed);
				advance = true;
			}
		}

		cancelInput();
		if (advance) advanceAfterAnswer();
	};

	function handleInput(data: string) {
		if (closed) return;
		if (inputMode) {
			if (isCancel(data)) {
				cancelInput();
				return;
			}
			editor.handleInput(data);
			refresh();
			return;
		}

		// Tab walks the whole focus ring (every answer, then the auxiliary controls),
		// which is the usual "Tab advances focus" convention. F6 keeps its shortcut
		// into the auxiliary row. Question and preview tabs live on ←/→ only.
		const shiftF6 = isShiftF6(data);
		if (currentQuestion() && (matchesKey(data, Key.f6) || shiftF6)) {
			const targets = (isMulti ? [undefined, "note", "skip"] : [undefined, "note"]) as readonly (AuxiliaryAction | undefined)[];
			const step = shiftF6 ? -1 : 1;
			const index = (targets.indexOf(focusedAction) + step + targets.length) % targets.length;
			focusedAction = targets[index];
			notice = undefined;
			refresh(focusedAction === undefined);
			return;
		}

		const previousFocus = matchesKey(data, Key.shift("tab"));
		const nextFocus = matchesKey(data, Key.tab);
		if (currentQuestion() && (nextFocus || previousFocus)) {
			cycleFocus(previousFocus ? -1 : 1);
			notice = undefined;
			refresh(focusedAction === undefined);
			return;
		}

		const pageUp = matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("pageUp")) || matchesKey(data, Key.alt("up")) || bound(data, "tui.editor.pageUp");
		const pageDown = matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("pageDown")) || matchesKey(data, Key.alt("down")) || bound(data, "tui.editor.pageDown");
		if (pageUp || pageDown) {
			const direction = pageUp ? -1 : 1;
			viewportOffset = Math.max(0, Math.min(
				Math.max(0, bodyLineCount - viewportHeight),
				viewportOffset + direction * Math.max(1, viewportHeight - 1),
			));
			refresh(false);
			return;
		}

		// Question and preview tabs are ←/→ only; a single-question flow has none.
		if (isMulti && matchesKey(data, Key.right)) {
			switchTab((currentTab + 1) % totalTabs);
			return;
		}
		if (isMulti && matchesKey(data, Key.left)) {
			switchTab((currentTab - 1 + totalTabs) % totalTabs);
			return;
		}

		if (currentTab === questions.length) {
			// Tab is focus movement, so on the review page it moves focus back into the
			// questionnaire instead of doing nothing.
			if (matchesKey(data, Key.tab)) {
				switchTab(0);
				return;
			}
			if (matchesKey(data, Key.shift("tab"))) {
				switchTab(questions.length - 1);
				return;
			}
			if (isConfirm(data)) {
				const pending = pendingQuestions()[0];
				if (pending) switchTab(questions.indexOf(pending));
				else submit(false);
			} else if (isCancel(data)) {
				submit(true);
			}
			return;
		}

		const q = currentQuestion();
		if (!q) return;

		// Direct shortcuts must not leave a stale auxiliary focus behind: otherwise the
		// next Enter replays whatever control happened to be highlighted.
		if (matchesKey(data, Key.ctrl("n"))) {
			focusedAction = undefined;
			activateAuxiliaryAction(q, "note");
			return;
		}
		if (isMulti && matchesKey(data, Key.ctrl("s"))) {
			focusedAction = undefined;
			activateAuxiliaryAction(q, "skip");
			return;
		}
		if (matchesKey(data, Key.ctrl("o"))) {
			if (previewOption(q)?.preview) {
				if (!expandedPreviews.delete(q.id)) expandedPreviews.add(q.id);
				viewportOffset = 0;
				refresh();
			}
			return;
		}

		if (focusedAction) {
			if (isConfirm(data) || matchesKey(data, Key.space)) {
				activateAuxiliaryAction(q, focusedAction);
			} else if (isAnswerUp(data) || isAnswerDown(data) || (q.kind !== "text" && (matchesKey(data, "j") || matchesKey(data, "k")))) {
				focusedAction = undefined;
				refresh();
			} else if (isCancel(data)) submit(true);
			return;
		}

		if (q.kind === "text" && isTypedText(data) && !isConfirm(data) && !isCancel(data)
			&& !isAnswerUp(data) && !isAnswerDown(data)) {
			startInput(q, "text");
			editor.handleInput(data);
			refresh();
			return;
		}

		const opts = currentOptions();
		optionIndex = clampOptionIndex(optionIndex, opts.length);

		if (isAnswerUp(data) || (q.kind !== "text" && matchesKey(data, "k"))) {
			const nextIndex = Math.max(0, optionIndex - 1);
			if (nextIndex === optionIndex && !notice && followFocus) return;
			optionIndex = nextIndex;
			notice = undefined;
			refresh();
			return;
		}
		if (isAnswerDown(data) || (q.kind !== "text" && matchesKey(data, "j"))) {
			const nextIndex = Math.min(opts.length - 1, optionIndex + 1);
			if (nextIndex === optionIndex && !notice && followFocus) return;
			optionIndex = nextIndex;
			notice = undefined;
			refresh();
			return;
		}

		const selected = opts[optionIndex];
		if (q.kind === "multi" && matchesKey(data, Key.space)) {
			if (selected?.type === "option") {
				const selection = ensureMultiSelection(q.id);
				if (selection.has(selected.value)) selection.delete(selected.value);
				else selection.add(selected.value);
				syncMultiAnswer(q);
			} else if (selected?.type === "customValue") {
				removeCustomMultiValue(q, selected.value);
				optionIndex = clampOptionIndex(optionIndex, currentOptions().length);
			}
			notice = undefined;
			refresh();
			return;
		}

		if (isConfirm(data)) {
			if (!selected) return;
			if (selected.type === "custom") {
				startInput(q, q.kind === "text" ? "text" : "custom");
				return;
			}
			if (q.kind === "multi") {
				const hasSelection = (multiSelections.get(q.id)?.size ?? 0) > 0 || (multiCustomValues.get(q.id)?.length ?? 0) > 0;
				// An explicit skip already answers the requirement for navigation purposes;
				// it stays unresolved in the result, but Enter must be able to move on.
				if (!hasSelection && q.required && !skippedIds.has(q.id)) {
					notice = isMulti ? UI_TEXT.requiredSelection : UI_TEXT.requiredSelectionSingle;
					refresh();
					return;
				}
				if (hasSelection) syncMultiAnswer(q);
				advanceAfterAnswer();
				return;
			}
			saveSingleAnswer(q, selected);
			advanceAfterAnswer();
			return;
		}

		if (isCancel(data)) {
			submit(true);
		}
	}

	function render(width: number): string[] {
		if (closed) return [];
		width = Math.max(1, Math.floor(width));
		const rows = Math.max(1, tui.terminal.rows);
		// Every state change clears `cachedLines`, so a cached frame with the same
		// geometry can be reused without rebuilding the body: the host measures and
		// then paints, which used to pay for two full body builds per keystroke.
		if (cachedLines && cachedWidth === width && cachedRows === rows) {
			const reused = resolveInlineLayout(tui, component, width, cachedRequestedHeight);
			if (reused.key === cachedLayoutKey) return cachedLines;
		}

		const lines: string[] = [];
		const q = currentQuestion();
		const opts = currentOptions();
		// Rendering is also used for measurement: clamp for drawing only, never write
		// back into the focus state.
		const activeIndex = clampOptionIndex(optionIndex, opts.length);
		const pending = pendingQuestions();
		// Body lines are clipped when the visible slice is assembled, so a long question
		// does not pay per-line truncation for rows the viewport never shows.
		const add = (text: string) => {
			for (const line of text.replace(/\r\n?/g, "\n").split("\n")) lines.push(line);
		};
		const addWrapped = (prefix: string, text: string) => {
			const prefixWidth = visibleWidth(prefix);
			if (prefixWidth >= width) {
				for (const line of wrapTextWithAnsi(prefix + text, width)) add(line);
				return;
			}
			const chunks = wrapTextWithAnsi(text, Math.max(1, width - prefixWidth));
			for (let i = 0; i < chunks.length; i++) add((i === 0 ? prefix : " ".repeat(prefixWidth)) + chunks[i]);
		};

		const tabs = questions.map((question) => {
			if (answers.has(question.id)) return { label: `■ ${question.label}`, color: "success" as const };
			if (skippedIds.has(question.id)) return question.required
				? { label: `! ${question.label}`, color: "warning" as const }
				: { label: `– ${question.label}`, color: "dim" as const };
			return { label: `□ ${question.label}`, color: "muted" as const };
		});
		const labels = [...tabs.map((tab) => tab.label), "预览"];
		const tabBar = isMulti ? renderTabBar(labels, currentTab, width, (text, active, index) => {
			if (active) return theme.bg("selectedBg", theme.fg("text", text));
			return theme.fg(index < tabs.length ? tabs[index].color : "muted", text);
		}) : "";
		let anchor: LineRange = { start: 0, end: 1 };
		// Without a real anchor (e.g. auxiliary controls focused) the viewport must keep
		// its current offset instead of snapping back to the top of the question.
		let hasAnchor = false;

		function renderAnswer(label: string, answer: AskUserAnswer) {
			const source = answerSourceLabel(answer);
			addWrapped(" ", theme.fg("muted", `${label}: ${source ? source + " " : ""}`) + theme.fg("text", answerDisplay(answer)));
		}

		function renderEditor() {
			let cursorLine = lines.length;
			for (const line of editor.render(Math.max(1, width - 2))) {
				if (line.includes(CURSOR_MARKER)) cursorLine = lines.length;
				add(" " + line);
			}
			anchor = { start: cursorLine, end: cursorLine + 1 };
			hasAnchor = true;
		}

		function renderPreview(option: AskUserOption) {
			const preview = previewLayouts.get(option, Math.max(1, width - 5), 15);
			addWrapped("     ", theme.fg("muted", `${UI_TEXT.previewPrefix}${option.label}`));
			for (const line of preview.lines) addWrapped("     ", theme.fg(line.code ? "dim" : "muted", line.text));
			if (preview.truncated) addWrapped("     ", theme.fg("dim", UI_TEXT.previewTruncated));
		}

		function renderChoices(question: NormalizedQuestion) {
			const answer = answers.get(question.id);
			const selectedValues = multiSelections.get(question.id);
			for (let i = 0; i < opts.length; i++) {
				const opt = opts[i];
				const selected = i === activeIndex;
				const active = selected && focusedAction === undefined;
				const chosen = question.kind === "single" && opt.type === "option" && answer?.value === opt.value && !answer.wasCustom;
				const typed = opt.type === "custom" && answer?.wasCustom && question.kind !== "multi";
				const prefix = active ? theme.fg("accent", "> ") : "  ";
				const color = active ? "accent" : "text";
				const firstLine = lines.length;
				if (question.kind === "multi" && (opt.type === "option" || opt.type === "customValue")) {
					const checked = opt.type === "customValue" || (selectedValues?.has(opt.value) ?? false);
					const label = opt.type === "customValue" ? `${UI_TEXT.customSource} ${opt.label}` : opt.label;
					const mark = checked && answer?.wasDefault ? ` ${UI_TEXT.defaultSource}` : "";
					addWrapped(prefix, theme.fg("dim", `${opt.index}. `) + theme.fg(checked ? "success" : "dim", checked ? "[x] " : "[ ] ") + theme.fg(color, label + mark));
				} else {
					const number = question.kind === "text" ? "" : `${opt.index}. `;
					const mark = chosen || typed ? theme.fg("success", answer?.wasDefault ? ` ✓ ${UI_TEXT.defaultSource}` : " ✓") : "";
					addWrapped(prefix, theme.fg(color, number + opt.label) + mark);
				}
				// Anchor the label, not an arbitrarily long explanation below it.
				if (active && !inputMode) {
					anchor = { start: firstLine, end: lines.length };
					hasAnchor = true;
				}
				if (opt.type === "option" && opt.description) addWrapped("     ", theme.fg("muted", opt.description));
				if (typed && answer && !(active && inputMode)) addWrapped("     ", theme.fg("muted", "↳ " + answerDisplay(answer)));
				if (selected && inputMode && inputPurpose !== "note") renderEditor();
				if (selected && !inputMode && opt.type === "option" && question.kind === "single" && opt.preview && expandedPreviews.has(question.id)) renderPreview(question.options[i]);
			}
		}

		if (q) {
			addWrapped(" ", theme.fg("text", q.prompt) + (q.required ? "" : theme.fg("dim", ` ${UI_TEXT.optional}`)));
			if (q.description) addWrapped(" ", theme.fg("muted", q.description));
			if (rows >= 12) add("");
			renderChoices(q);
			if (skippedIds.has(q.id)) addWrapped(" ", theme.fg(q.required ? "warning" : "dim", q.required ? UI_TEXT.skippedRequired : UI_TEXT.skipped));
			if (inputMode && inputPurpose === "note") {
				add(theme.fg("muted", ` ${UI_TEXT.noteEditor}`));
				renderEditor();
			} else {
				const note = notes.get(q.id);
				if (note) {
					const firstLine = note.split(/[\r\n]/, 1)[0] || "";
					const prefix = ` ${UI_TEXT.notePrefix}`;
					add(theme.fg("muted", prefix + truncatePlainText(firstLine + (firstLine.length < note.length ? " …" : ""), Math.max(1, width - visibleWidth(prefix)))));
				}
			}
		} else {
			const count = pending.length ? theme.fg("muted", `  ${pending.length} 项待处理`) : "";
			addWrapped(" ", theme.fg("accent", theme.bold("回答预览")) + count);
			add("");
			for (const question of questions) {
				const answer = answers.get(question.id);
				if (answer) renderAnswer(question.label, answer);
				else {
					let status: string;
					let color: "muted" | "text" | "warning";
					if (skippedIds.has(question.id)) {
						status = question.required ? UI_TEXT.skippedRequired : UI_TEXT.skipped;
						color = question.required ? "warning" : "muted";
					} else {
						status = question.required ? "待回答" : "未填写 · 可选";
						color = question.required ? "text" : "muted";
					}
					addWrapped(" ", theme.fg("muted", `${question.label}: `) + theme.fg(color, status));
				}
				const note = notes.get(question.id);
				if (note) addWrapped("   ", theme.fg("muted", `${UI_TEXT.notePrefix}${note}`));
			}
		}

		// Help is a secondary command legend, never part of answer selection.
		const hints: string[] = [];
		if (inputMode) hints.push(UI_TEXT.editorHelp);
		else if (!q) {
			const action = pending.length ? "继续回答" : "提交回答";
			const compact = pending.length ? "补答" : "提交";
			const variants = [`Enter ${action} · Tab 返回题目 · ←→ 切题 · Esc 取消`, `Enter ${action} · Tab 返回题目`, `Enter ${action}`, `Enter ${compact}`, `↵${compact}`];
			hints.push(variants.find((text) => visibleWidth(text) <= width - 1) || "↵");
		}
		else if (focusedAction) hints.push(UI_TEXT.auxiliaryHelp);
		else {
			const preview = previewOption(q)?.preview ? UI_TEXT.previewHelp : "";
			const last = currentTab === questions.length - 1;
			const base = q.kind === "multi"
				? (!isMulti ? UI_TEXT.multiHelpSubmit : last ? UI_TEXT.multiHelpLast : UI_TEXT.multiHelp)
				: (!isMulti ? UI_TEXT.singleHelpSubmit : last ? UI_TEXT.singleHelpLast : UI_TEXT.singleHelp);
			hints.push(base + preview + UI_TEXT.cancelHelp);
		}
		const hasActions = Boolean(q) && !inputMode;
		// Fixed rules frame the scrolling body. Only an actually cramped editor
		// slot may drop them; question length must not change the outer boundary.
		const body = lines;
		// 5 chrome rows with a tab row and its gap, 4 without.
		const requestedHeight = Math.min(getInlineMaxHeight(rows), body.length + hints.length + Number(hasActions) + (isMulti ? 5 : 4) + (notice ? 1 : 0));
		const allocation = resolveInlineLayout(tui, component, width, requestedHeight);
		if (cachedLines && cachedWidth === width && cachedRows === rows && cachedLayoutKey === allocation.key) return cachedLines;
		if (layoutWidth !== width || layoutRows !== rows || cachedLayoutKey !== allocation.key) followFocus = true;
		layoutWidth = width;
		layoutRows = rows;
		const maxHeight = Math.max(1, allocation.height);
		// Auxiliary controls outrank ordinary help; even a two-row slot keeps one
		// answer row and one action row. A one-row slot reveals the focused group.
		const actionHeight = hasActions && (maxHeight >= 2 || focusedAction !== undefined) ? 1 : 0;
		const showSeparators = maxHeight >= MIN_FRAMED_HEIGHT;
		const separatorHeight = showSeparators ? 2 : 0;
		// Keep tab-to-content spacing stable just like the outer rules. Reserve it
		// before the body, not from whatever a shorter question happens to leave.
		// A single-question flow has no tab row, so it needs no gap either.
		const headerGapHeight = Number(showSeparators && isMulti);
		const essentialChrome = 1 + hints.length + actionHeight + separatorHeight + headerGapHeight + Number(Boolean(notice));
		const minimumBodyHeight = Math.min(body.length, maxHeight - actionHeight - separatorHeight - headerGapHeight, Math.max(2, maxHeight - essentialChrome));
		let chromeBudget = Math.max(0, maxHeight - minimumBodyHeight - actionHeight - separatorHeight - headerGapHeight);
		const header = chromeBudget > 0 && isMulti ? [tabBar] : [];
		chromeBudget -= header.length;
		const showNotice = Boolean(notice) && chromeBudget > 0;
		if (showNotice) chromeBudget--;
		const hintCount = Math.min(hints.length, chromeBudget);
		chromeBudget -= hintCount;

		const rule = theme.fg("accent", "─".repeat(width));
		const heading = width >= 8 ? truncatePlainText(titleLabel, width - 4) : "";
		const topRule = heading
			? theme.fg("accent", "─") + theme.fg("text", theme.bold(` ${heading} `)) + theme.fg("accent", "─".repeat(width - visibleWidth(heading) - 3))
			: rule;
		if (showSeparators) header.unshift(topRule);
		if (headerGapHeight) header.push("");
		const footerGap = showSeparators && chromeBudget > 0;

		const footerHeight = actionHeight + Number(showNotice) + hintCount + Number(showSeparators) + Number(footerGap);
		const visibleBodyHeight = Math.max(0, maxHeight - header.length - footerHeight);
		viewportHeight = Math.max(1, visibleBodyHeight);
		bodyLineCount = body.length;
		const viewport = resolveViewport(body.length, viewportHeight, viewportOffset, followFocus && hasAnchor ? anchor : undefined);
		viewportOffset = viewport.start;
		const footer: string[] = footerGap ? [""] : [];
		if (showNotice) footer.push(truncateStyledText(theme.fg("warning", " " + notice), width));
		if (actionHeight) {
			const indent = width > 20 ? " " : "";
			footer.push(indent + renderAuxiliaryActions(width - indent.length, focusedAction, (text, action, active) => active
				? theme.bg("selectedBg", theme.fg("text", text))
				: theme.fg(action ? "muted" : "dim", text), { skippable: isMulti }));
		}
		for (let i = 0; i < hintCount; i++) {
			// Without a tab row there is no place for the hidden-line counts, so the
			// single-question footer carries them instead.
			const overflowCounts = `${viewport.hiddenBefore ? `↑${viewport.hiddenBefore} ` : ""}${viewport.hiddenAfter ? `↓${viewport.hiddenAfter} ` : ""}`.trim();
			const scrollPrefix = isMulti || !overflowCounts ? UI_TEXT.scrollHelp : `${overflowCounts} ${UI_TEXT.scrollHelp}`;
			const paging = i === 0 && !inputMode && body.length > viewportHeight ? scrollPrefix : "";
			// Preview's next action must remain whole, not merely precede a suffix
			// that could cause truncation to eat its final word on narrow screens.
			const scrollHint = paging ? " · Alt+↑↓ 滚动" : "";
			const fitsScroll = visibleWidth(hints[i] + scrollHint) <= width - 1;
			const hint = q ? paging + hints[i] : hints[i] + (fitsScroll ? scrollHint : "");
			footer.push(truncateStyledText(theme.fg("dim", " " + hint), width));
		}
		if (showSeparators) footer.push(rule);
		if (isMulti && header.length && (viewport.hiddenBefore || viewport.hiddenAfter)) {
			const overflow = `${viewport.hiddenBefore ? `↑${viewport.hiddenBefore} ` : ""}${viewport.hiddenAfter ? `↓${viewport.hiddenAfter} ` : ""}`;
			const info = theme.fg("dim", " " + overflow.trim());
			const tabIndex = showSeparators ? 1 : 0;
			if (visibleWidth(header[tabIndex]) + visibleWidth(info) <= width) header[tabIndex] += info;
		}
		const visibleBody = visibleBodyHeight
			? body.slice(viewport.start, viewport.end).map((line) => truncateStyledText(line, width))
			: [];
		cachedLines = [...header, ...visibleBody, ...footer];
		// Preserve intrinsic measurement without moving useful content below clipping.
		while (cachedLines.length < allocation.naturalHeight) cachedLines.push("");
		cachedLayoutKey = allocation.key;
		cachedRequestedHeight = requestedHeight;
		cachedWidth = width;
		cachedRows = rows;
		return cachedLines;
	}

	const component = {
		get focused() { return focused; },
		set focused(value: boolean) {
			if (focused === value) return;
			focused = value;
			editor.focused = value && inputMode && !closed;
			refresh();
		},
		render,
		dispose: () => submit(true),
		invalidate: () => {
			editor.invalidate();
			cachedLines = undefined;
			cachedWidth = undefined;
		},
		handleInput,
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	if (signal?.aborted) onAbort();
	return component;
}
