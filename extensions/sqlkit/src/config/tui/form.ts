import { Input, matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";
import { formatConnectionFailure, formatSuccessfulConnection, formatTestingStatus } from "./connection-test.js";

const INLINE_INPUT_PROMPT = "> ";

type AddSourceField = { key: string; label: string; value: string; required: boolean; hint?: string; placeholder?: string };
type SourceFormOptions = { title?: string; note?: string };

function renderInlineInput(input: Input, width: number): string {
	const [line = ""] = input.render(width + INLINE_INPUT_PROMPT.length);
	return line.startsWith(INLINE_INPUT_PROMPT) ? line.slice(INLINE_INPUT_PROMPT.length) : line;
}

/**
 * Opens a full-screen form for editing datasource fields.
 * Returns null when the user cancels, or the mutated fields array on save.
 */
export async function showSourceForm(
	ctx: { ui: { custom?: <T>(factory: (...args: any[]) => any) => Promise<T> } },
	dialect: "mysql" | "clickhouse",
	fields: AddSourceField[],
	existingNames: Set<string>,
	onTestConnection: (fields: AddSourceField[]) => Promise<string>,
	options: SourceFormOptions = {},
): Promise<AddSourceField[] | null> {
	return ctx.ui.custom!<AddSourceField[] | null>((tui: any, theme: any, _kb: any, done: any) => {
		let selectedIndex = 0;
		let editing = false;
		let testStatus: string | null = null;
		let testing = false;
		let closed = false;
		let testStartedAt = 0;
		let testTimer: ReturnType<typeof setInterval> | undefined;
		const input = new Input();

		function refresh() {
			input.invalidate();
			tui.requestRender();
		}

		function clearTestTimer() {
			if (testTimer) clearInterval(testTimer);
			testTimer = undefined;
		}

		function close(value: AddSourceField[] | null) {
			closed = true;
			clearTestTimer();
			done(value);
		}

		function elapsedTestSeconds(rounding: "floor" | "ceil" = "floor"): number {
			const elapsed = (Date.now() - testStartedAt) / 1000;
			return Math.max(0, rounding === "ceil" ? Math.ceil(elapsed) : Math.floor(elapsed));
		}

		function updateTestingStatus() {
			testStatus = formatTestingStatus(elapsedTestSeconds());
			refresh();
		}

		function currentField(): AddSourceField | undefined {
			return fields[selectedIndex];
		}

		function effectiveFieldValue(field: AddSourceField): string {
			return field.value.trim() || field.placeholder?.trim() || "";
		}

		function fieldError(field: AddSourceField): string | null {
			const value = effectiveFieldValue(field);
			if (field.required && !value) {
				return `Missing required field: ${field.label}`;
			}
			if (field.key === "name" && value && existingNames.has(value)) {
				return `Source name "${value}" already exists`;
			}
			if (field.key === "port") {
				const port = Number(value);
				if (!Number.isInteger(port) || port <= 0 || port > 65535) {
					return "Port must be an integer between 1 and 65535";
				}
			}
			return null;
		}

		function validationMessage(): string {
			for (const field of fields) {
				const error = fieldError(field);
				if (error) return error;
			}
			return "Ready to save";
		}

		function saveAndClose() {
			const message = validationMessage();
			if (message !== "Ready to save") {
				testStatus = message;
				refresh();
				return;
			}
			close(fields);
		}

		function startEditing() {
			const field = currentField();
			if (!field) return;
			editing = true;
			input.setValue(field.value);
			input.handleInput("\x05");
			input.onSubmit = () => {
				field.value = input.getValue();
				editing = false;
				if (selectedIndex < fields.length - 1) selectedIndex += 1;
				else saveAndClose();
				input.onSubmit = undefined;
				refresh();
			};
			refresh();
		}

		function commitEdit() {
			const field = currentField();
			if (!field) return;
			field.value = input.getValue();
			editing = false;
			input.onSubmit = undefined;
			refresh();
		}

		function cancelEdit() {
			editing = false;
			input.onSubmit = undefined;
			refresh();
		}

		function moveSelection(delta: number) {
			selectedIndex = Math.max(0, Math.min(fields.length - 1, selectedIndex + delta));
			refresh();
		}

		function render(width: number): string[] {
			const th = theme;
			const panelWidth = Math.min(width, 88);
			const inner = Math.max(24, panelWidth);
			const labelWidth = Math.max(
				12,
				Math.min(18, fields.reduce((max, field) => Math.max(max, field.label.length + (field.required ? 2 : 0)), 0) + 1),
			);
			const valueWidth = Math.max(12, inner - labelWidth - 6);
			const lines: string[] = [];
			const rule = th.fg("borderMuted", "─".repeat(inner));
			const sectionRule = th.fg("borderMuted", "·".repeat(Math.max(12, inner - 2)));
			const pad = (text: string) => truncateToWidth(text, panelWidth, "", false);
			const title = options.title ?? `${dialect === "mysql" ? "Add MySQL Source" : "Add ClickHouse Source"}`;
			const badge = th.bg("selectedBg", ` ${dialect} `);
			const note = th.fg("dim", options.note ?? "readonly");

			const sectionFor = (fieldKey: string): string => {
				if (["host", "port", "user", "password"].includes(fieldKey)) return "Connection";
				if (["name", "database"].includes(fieldKey)) return "General";
				return "Settings";
			};

			let lastSection: string | undefined;

			lines.push(pad(`${th.bold(title)}  ${badge}  ${note}`));
			lines.push(rule);

			for (const [index, field] of fields.entries()) {
				const section = sectionFor(field.key);
				if (section !== lastSection) {
					if (lastSection) lines.push(pad(sectionRule));
					lines.push(pad(th.fg("muted", th.bold(section.toUpperCase()))));
					lastSection = section;
				}

				const isSelected = index === selectedIndex;
				const isEditing = isSelected && editing;
				const rawLabel = `${field.label}${field.required ? " *" : ""}`.padEnd(labelWidth, " ");
				const label = isSelected ? th.fg("accent", th.bold(rawLabel)) : th.fg("muted", rawLabel);

				let value = field.value;
				if (!value && field.key === "name") {
					const hostField = fields.find((f) => f.key === "host");
					const portField = fields.find((f) => f.key === "port");
					const host = hostField?.value || hostField?.placeholder || "127.0.0.1";
					const port = portField?.value || portField?.placeholder || (dialect === "mysql" ? "3306" : "8123");
					value = th.fg("dim", `${host}:${port}`);
				} else if (!value && field.key === "database") {
					value = th.fg("dim", "(optional)");
				} else if (!value && field.placeholder) {
					value = th.fg("dim", field.placeholder);
				}
				if (isEditing) {
					input.focused = true;
					value = renderInlineInput(input, valueWidth);
				} else {
					input.focused = false;
					const baseValue = truncateToWidth(String(value), valueWidth, "...");
					value = baseValue;
				}

				const marker = isSelected ? th.fg("accent", "▍") : " ";
				let row = `${marker} ${label} ${value}`;
				row = truncateToWidth(row, inner, "", false);
				if (isSelected && !isEditing) {
					row = theme.bg("selectedBg", row);
				}
				lines.push(pad(row));
			}

			lines.push(rule);
			if (testStatus) {
				const ok = testStatus === "Ready to save" || testStatus.startsWith("Connected");
				lines.push(pad(ok ? th.fg("success", `✓ ${testStatus}`) : th.fg("warning", testStatus)));
			}
			const help = editing
				? "Enter accept  Tab next  Esc cancel"
				: "↑↓/Tab move  Enter edit  Ctrl+S save  Ctrl+T test  Esc cancel";
			lines.push(pad(th.fg("dim", help)));

			return lines;
		}

		function handleInput(data: string) {
			if (matchesKey(data, "escape")) {
				if (editing) { cancelEdit(); return; }
				close(null);
				return;
			}

			if (editing) {
				if (matchesKey(data, "shift+tab") || matchesKey(data, Key.shift("tab"))) {
					commitEdit();
					moveSelection(-1);
					return;
				}
				if (matchesKey(data, "tab") || matchesKey(data, Key.tab)) {
					commitEdit();
					moveSelection(1);
					return;
				}
				input.handleInput(data);
				refresh();
				return;
			}

			if (matchesKey(data, Key.up)) { moveSelection(-1); return; }
			if (matchesKey(data, Key.down)) { moveSelection(1); return; }
			if (matchesKey(data, Key.enter)) { startEditing(); return; }
			if (matchesKey(data, "shift+tab") || matchesKey(data, Key.shift("tab"))) { moveSelection(-1); return; }
			if (matchesKey(data, Key.tab) || matchesKey(data, "tab")) { moveSelection(1); return; }
			if (matchesKey(data, Key.ctrl("s"))) { saveAndClose(); return; }
			if (matchesKey(data, Key.ctrl("t"))) {
				if (testing) return;
				const message = validationMessage();
				if (message !== "Ready to save") {
					testStatus = message;
					refresh();
					return;
				}
				testing = true;
				testStartedAt = Date.now();
				updateTestingStatus();
				testTimer = setInterval(updateTestingStatus, 1000);
				onTestConnection(fields).then((result) => {
					if (closed) return;
					const seconds = Math.max(1, elapsedTestSeconds("ceil"));
					const connected = result.startsWith("Connected:");
					testStatus = connected
						? formatSuccessfulConnection(seconds, result)
						: formatConnectionFailure(result);
				}).catch((err) => {
					if (closed) return;
					testStatus = formatConnectionFailure(err instanceof Error ? err.message : String(err));
				}).finally(() => {
					if (closed) return;
					testing = false;
					clearTestTimer();
					refresh();
				});
				return;
			}
		}

		return { render, handleInput, invalidate: () => {} };
	});
}
