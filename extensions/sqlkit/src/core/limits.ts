import { Buffer } from "node:buffer";
import type { QueryExecutionLimits, ResolvedDataSource, ResultColumnProfile, ResultProfile } from "../types.js";
import { asPositiveInt } from "../utils.js";

const DEFAULT_MAX_ROWS = 50;
const ABSOLUTE_MAX_ROWS = 500;
const DEFAULT_MAX_RESULT_BYTES = 256_000;
const DEFAULT_MAX_CELL_CHARS = 4_000;

type ShapeRowsInput = {
	columns?: string[];
	rows: unknown[][];
	limits: QueryExecutionLimits;
	includeProfile?: boolean;
	warnings?: string[];
};

type ShapeRowsResult = {
	rows: unknown[][];
	rowCount: number;
	truncated: boolean;
	resultProfile?: ResultProfile;
	warnings: string[];
};

type ProfileColumnAccumulator = {
	name: string;
	nullCount: number;
	nonNullCount: number;
	typeTags: Set<string>;
	distinct: Map<string, { value: unknown; count: number }>;
	sampleValues: unknown[];
	numberMin?: number;
	numberMax?: number;
	numberSum: number;
	numberCount: number;
	stringMinLength?: number;
	stringMaxLength?: number;
	stringLengthSum: number;
	stringCount: number;
};

const PROFILE_SAMPLE_VALUE_LIMIT = 5;
const PROFILE_TOP_VALUE_LIMIT = 5;
const PROFILE_VALUE_MAX_CHARS = 120;

export function resolveQueryExecutionLimits(source: ResolvedDataSource, requestedMaxRows?: number): QueryExecutionLimits {
	const requested = Number.isFinite(requestedMaxRows) ? Math.floor(requestedMaxRows ?? DEFAULT_MAX_ROWS) : DEFAULT_MAX_ROWS;
	const maxRows = Math.min(Math.max(requested, 1), ABSOLUTE_MAX_ROWS);
	const maxResultBytes = asPositiveInt(source.options.max_result_bytes, DEFAULT_MAX_RESULT_BYTES);
	const maxCellChars = asPositiveInt(source.options.max_cell_chars, DEFAULT_MAX_CELL_CHARS);
	return {
		maxRows,
		fetchRows: maxRows + 1,
		maxResultBytes,
		maxCellChars,
	};
}

function normalizeCell(value: unknown, maxCellChars: number, flags: { cellTruncated: boolean; cellStringified: boolean }): unknown {
	if (value == null || typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "string") {
		if (value.length <= maxCellChars) return value;
		flags.cellTruncated = true;
		return `${value.slice(0, maxCellChars)}...`;
	}
	if (value instanceof Date) return value.toISOString();
	if (value instanceof Uint8Array) {
		flags.cellStringified = true;
		return `[binary ${value.byteLength} bytes]`;
	}

	flags.cellStringified = true;
	let text: string;
	try {
		text = JSON.stringify(value);
	} catch {
		text = String(value);
	}
	if (text.length <= maxCellChars) return text;
	flags.cellTruncated = true;
	return `${text.slice(0, maxCellChars)}...`;
}

function normalizeProfileValue(value: unknown): unknown {
	if (value == null || typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "string") {
		return value.length <= PROFILE_VALUE_MAX_CHARS ? value : `${value.slice(0, PROFILE_VALUE_MAX_CHARS)}...`;
	}
	if (value instanceof Date) return value.toISOString();
	if (value instanceof Uint8Array) return `[binary ${value.byteLength} bytes]`;
	let text: string;
	try {
		text = JSON.stringify(value);
	} catch {
		text = String(value);
	}
	return text.length <= PROFILE_VALUE_MAX_CHARS ? text : `${text.slice(0, PROFILE_VALUE_MAX_CHARS)}...`;
}

function profileValueKey(value: unknown): string {
	const normalized = normalizeProfileValue(value);
	return JSON.stringify(normalized) ?? String(normalized);
}

function inferTypeTag(value: unknown): string {
	if (value == null) return "null";
	if (typeof value === "boolean") return "boolean";
	if (typeof value === "bigint") return "integer";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return "number";
		return Number.isInteger(value) ? "integer" : "float";
	}
	if (typeof value === "string") return "string";
	return "unknown";
}

function finalizeInferredType(typeTags: Set<string>): ResultColumnProfile["inferred_type"] {
	const tags = Array.from(typeTags).filter((tag) => tag !== "null");
	if (tags.length === 0) return typeTags.has("null") ? "null" : "unknown";
	if (tags.includes("unknown")) return tags.length === 1 ? "unknown" : "mixed";
	if (tags.length === 1) return tags[0] as ResultColumnProfile["inferred_type"];
	if (tags.every((tag) => tag === "integer" || tag === "float" || tag === "number")) {
		if (tags.includes("number")) return "number";
		return tags.includes("float") ? "float" : "integer";
	}
	return "mixed";
}

function createAccumulator(name: string): ProfileColumnAccumulator {
	return {
		name,
		nullCount: 0,
		nonNullCount: 0,
		typeTags: new Set<string>(),
		distinct: new Map<string, { value: unknown; count: number }>(),
		sampleValues: [],
		numberSum: 0,
		numberCount: 0,
		stringLengthSum: 0,
		stringCount: 0,
	};
}

function observeProfileCell(accumulator: ProfileColumnAccumulator, value: unknown): void {
	const typeTag = inferTypeTag(value);
	accumulator.typeTags.add(typeTag);
	if (value == null) {
		accumulator.nullCount += 1;
		return;
	}

	accumulator.nonNullCount += 1;
	const normalized = normalizeProfileValue(value);
	const key = profileValueKey(normalized);
	const current = accumulator.distinct.get(key);
	if (current) {
		current.count += 1;
	} else {
		accumulator.distinct.set(key, { value: normalized, count: 1 });
	}
	if (accumulator.sampleValues.length < PROFILE_SAMPLE_VALUE_LIMIT) {
		accumulator.sampleValues.push(normalized);
	}

	if (typeof value === "number" && Number.isFinite(value)) {
		accumulator.numberMin = accumulator.numberMin == null ? value : Math.min(accumulator.numberMin, value);
		accumulator.numberMax = accumulator.numberMax == null ? value : Math.max(accumulator.numberMax, value);
		accumulator.numberSum += value;
		accumulator.numberCount += 1;
	}
	if (typeof value === "bigint") {
		const numeric = Number(value);
		if (Number.isSafeInteger(numeric)) {
			accumulator.numberMin = accumulator.numberMin == null ? numeric : Math.min(accumulator.numberMin, numeric);
			accumulator.numberMax = accumulator.numberMax == null ? numeric : Math.max(accumulator.numberMax, numeric);
			accumulator.numberSum += numeric;
			accumulator.numberCount += 1;
		}
	}
	if (typeof value === "string") {
		const length = value.length;
		accumulator.stringMinLength = accumulator.stringMinLength == null ? length : Math.min(accumulator.stringMinLength, length);
		accumulator.stringMaxLength = accumulator.stringMaxLength == null ? length : Math.max(accumulator.stringMaxLength, length);
		accumulator.stringLengthSum += length;
		accumulator.stringCount += 1;
	}
}

function roundRatio(value: number): number {
	return Math.round(value * 1000) / 1000;
}

function buildResultProfile(columns: string[], rows: unknown[][]): ResultProfile {
	const accumulators = columns.map((name) => createAccumulator(name));
	for (const row of rows) {
		for (let index = 0; index < accumulators.length; index += 1) {
			observeProfileCell(accumulators[index]!, row[index]);
		}
	}
	const sampledRows = rows.length;
	return {
		profile_scope: "sampled_result_rows",
		sampled_rows: sampledRows,
		columns: accumulators.map((accumulator): ResultColumnProfile => {
			const topValues = Array.from(accumulator.distinct.values())
				.sort((left, right) => right.count - left.count || String(left.value).localeCompare(String(right.value)))
				.slice(0, PROFILE_TOP_VALUE_LIMIT)
				.map((entry) => ({ value: entry.value, count: entry.count }));
			const profile: ResultColumnProfile = {
				name: accumulator.name,
				inferred_type: finalizeInferredType(accumulator.typeTags),
				null_count: accumulator.nullCount,
				non_null_count: accumulator.nonNullCount,
				null_ratio: sampledRows === 0 ? 0 : roundRatio(accumulator.nullCount / sampledRows),
				distinct_non_null_in_sample: accumulator.distinct.size,
				sample_values: accumulator.sampleValues,
				top_values: topValues,
			};
			if (accumulator.numberCount > 0) {
				profile.number = {
					min: accumulator.numberMin ?? 0,
					max: accumulator.numberMax ?? 0,
					avg: roundRatio(accumulator.numberSum / accumulator.numberCount),
				};
			}
			if (accumulator.stringCount > 0) {
				profile.string = {
					min_length: accumulator.stringMinLength ?? 0,
					max_length: accumulator.stringMaxLength ?? 0,
					avg_length: roundRatio(accumulator.stringLengthSum / accumulator.stringCount),
				};
			}
			return profile;
		}),
	};
}

export function shapeQueryRows(input: ShapeRowsInput): ShapeRowsResult {
	const warnings = [...(input.warnings ?? [])];
	const flags = { cellTruncated: false, cellStringified: false };
	const rowLimited = input.rows.length > input.limits.maxRows;
	const rows = input.rows
		.slice(0, input.limits.maxRows)
		.map((row) => row.map((cell) => normalizeCell(cell, input.limits.maxCellChars, flags)));

	// Incremental byte counting avoids O(n^2) JSON.stringify on full array.
	const rowSizes = rows.map((r) => Buffer.byteLength(JSON.stringify(r), "utf-8"));
	let totalBytes = rowSizes.reduce((a, b) => a + b, 0) + Math.max(0, rows.length - 1) + 2;
	let byteLimited = false;
	while (rows.length > 0 && totalBytes > input.limits.maxResultBytes) {
		totalBytes -= rowSizes.pop()! + 1;
		rows.pop();
		byteLimited = true;
	}

	if (rowLimited) warnings.push(`Result set exceeded ${input.limits.maxRows} rows and was truncated.`);
	if (flags.cellTruncated) warnings.push(`Some cell values exceeded ${input.limits.maxCellChars} characters and were truncated.`);
	if (flags.cellStringified) warnings.push("Some non-scalar cell values were stringified for safe JSON output.");
	if (byteLimited) warnings.push(`Result JSON exceeded ${input.limits.maxResultBytes} bytes and was truncated to ${rows.length} rows.`);

	return {
		rows,
		rowCount: rows.length,
		truncated: rowLimited || flags.cellTruncated || byteLimited,
		resultProfile: input.includeProfile && input.columns ? buildResultProfile(input.columns, rows) : undefined,
		warnings,
	};
}
