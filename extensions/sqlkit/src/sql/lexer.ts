export type SqlToken =
	| { type: "word"; value: string; normalized: string }
	| { type: "quoted_identifier"; value: string; normalized: string }
	| { type: "variable"; value: string; normalized: string }
	| { type: "symbol"; value: string };

export type SqlScanResult = {
	normalizedQuery: string;
	visibleSql: string;
	maskedSql: string;
	tokens: SqlToken[];
	hasMultipleStatements: boolean;
};

import { normalizeIdentifier } from "../core/access.js";

type QuoteStart = "'" | '"' | "`" | "[";

function isEscapedByBackslash(input: string, index: number): boolean {
	let count = 0;
	for (let cursor = index - 1; cursor >= 0 && input[cursor] === "\\"; cursor--) count++;
	return count % 2 === 1;
}

function maskText(value: string): string {
	return value.replace(/[^\r\n]/g, " ");
}

function quoteEnd(quote: QuoteStart): "'" | '"' | "`" | "]" {
	return quote === "[" ? "]" : quote;
}

function readQuotedValue(input: string, start: number, quote: QuoteStart): { raw: string; value: string; nextIndex: number } {
	const endQuote = quoteEnd(quote);
	let index = start + 1;
	let value = "";
	while (index < input.length) {
		const current = input[index];
		const next = input[index + 1];
		if (current === endQuote) {
			if (quote !== "[" && next === endQuote) {
				value += current;
				index += 2;
				continue;
			}
			if (quote !== "'" || !isEscapedByBackslash(input, index)) {
				return { raw: input.slice(start, index + 1), value, nextIndex: index + 1 };
			}
		}
		if (quote === "'" && current === "\\" && next != null) {
			value += next;
			index += 2;
			continue;
		}
		value += current;
		index++;
	}
	return { raw: input.slice(start), value, nextIndex: index };
}

export function scanSql(input: string): SqlScanResult {
	const normalizedQuery = input.trim().replace(/;+$/g, "").trim();
	let visibleSql = "";
	let maskedSql = "";
	const tokens: SqlToken[] = [];
	let hasMultipleStatements = false;
	let afterStatementTerminator = false;

	for (let index = 0; index < normalizedQuery.length; index++) {
		const char = normalizedQuery[index];
		const next = normalizedQuery[index + 1];

		if (char === "-" && next === "-") {
			const start = index;
			index += 2;
			while (index < normalizedQuery.length && normalizedQuery[index] !== "\n") index++;
			const comment = normalizedQuery.slice(start, index);
			visibleSql += " ";
			maskedSql += maskText(comment);
			if (index < normalizedQuery.length) {
				visibleSql += normalizedQuery[index];
				maskedSql += normalizedQuery[index];
			}
			continue;
		}
		if (char === "#") {
			const start = index;
			index++;
			while (index < normalizedQuery.length && normalizedQuery[index] !== "\n") index++;
			const comment = normalizedQuery.slice(start, index);
			visibleSql += " ";
			maskedSql += maskText(comment);
			if (index < normalizedQuery.length) {
				visibleSql += normalizedQuery[index];
				maskedSql += normalizedQuery[index];
			}
			continue;
		}
		if (char === "/" && next === "*") {
			const third = normalizedQuery[index + 2];
			if (third === "!") {
				// MySQL conditional comment /*! ... */ (also /*!50100 ... */).
				// MySQL executes the inner content as SQL, so masking it would
				// let forbidden keywords and table references hide from the
				// guard and access policy. Strip the opening marker and let
				// the main loop process the inner content as ordinary SQL; a
				// dedicated branch below strips the closing */ without masking.
				visibleSql += " ";
				maskedSql += " ";
				index += 2; // skip past / *; loop's index++ lands on !
				// skip optional version digits (e.g. 50100 in /*!50100 ... */)
				while (index + 1 < normalizedQuery.length && /\d/.test(normalizedQuery[index + 1])) {
					index++;
				}
				continue;
			}
			// Regular block comment: mask entirely.
			const start = index;
			index += 2;
			while (index < normalizedQuery.length && !(normalizedQuery[index] === "*" && normalizedQuery[index + 1] === "/")) index++;
			index = Math.min(normalizedQuery.length - 1, index + 1);
			const comment = normalizedQuery.slice(start, index + 1);
			visibleSql += " ";
			maskedSql += maskText(comment);
			continue;
		}
		// Closing */ of a MySQL conditional comment: strip the marker without
		// masking — the inner content has already flowed through the main loop.
		if (char === "*" && next === "/") {
			visibleSql += " ";
			maskedSql += " ";
			index += 1; // skip the /; loop's index++ moves past it
			continue;
		}

		if (char === "'") {
			const quoted = readQuotedValue(normalizedQuery, index, "'");
			visibleSql += quoted.raw;
			maskedSql += maskText(quoted.raw);
			if (afterStatementTerminator && quoted.raw.trim()) hasMultipleStatements = true;
			index = quoted.nextIndex - 1;
			continue;
		}

		if (char === '"' || char === "`" || char === "[") {
			const quoted = readQuotedValue(normalizedQuery, index, char);
			visibleSql += quoted.raw;
			maskedSql += maskText(quoted.raw);
			tokens.push({
				type: "quoted_identifier",
				value: quoted.value,
				normalized: normalizeIdentifier(quoted.value),
			});
			if (afterStatementTerminator && quoted.raw.trim()) hasMultipleStatements = true;
			index = quoted.nextIndex - 1;
			continue;
		}

		visibleSql += char;
		maskedSql += char;

		if (char === ";") {
			tokens.push({ type: "symbol", value: char });
			afterStatementTerminator = true;
			continue;
		}
		if (/\s/.test(char)) continue;
		if (afterStatementTerminator) {
			hasMultipleStatements = true;
			continue;
		}
		if (char === "@" && next != null && /[A-Za-z0-9_$]/.test(next)) {
			const start = index;
			index++;
			while (index + 1 < normalizedQuery.length && /[A-Za-z0-9_$]/.test(normalizedQuery[index + 1])) {
				index++;
				visibleSql += normalizedQuery[index];
				maskedSql += normalizedQuery[index];
			}
			const value = normalizedQuery.slice(start, index + 1);
			tokens.push({ type: "variable", value, normalized: normalizeIdentifier(value) });
			continue;
		}
		if (/[A-Za-z0-9_$]/.test(char)) {
			const start = index;
			while (index + 1 < normalizedQuery.length && /[A-Za-z0-9_$]/.test(normalizedQuery[index + 1])) {
				index++;
				visibleSql += normalizedQuery[index];
				maskedSql += normalizedQuery[index];
			}
			const value = normalizedQuery.slice(start, index + 1);
			tokens.push({ type: "word", value, normalized: normalizeIdentifier(value) });
			continue;
		}
		if ("(),.".includes(char)) tokens.push({ type: "symbol", value: char });
	}

	return {
		normalizedQuery,
		visibleSql,
		maskedSql,
		tokens,
		hasMultipleStatements,
	};
}

export function tokenizeSql(input: string): SqlToken[] {
	return scanSql(input).tokens;
}
