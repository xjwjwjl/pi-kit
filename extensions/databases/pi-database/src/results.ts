const MAX_RESULT_BYTES = 50_000;
const MAX_CELL_CHARS = 2_000;
const MAX_TABLE_RESULTS = 500;

export type BoundedRows = {
  rows: unknown[][];
  truncated: boolean;
  warnings: string[];
};

export function truncateText(value: string): { value: string; truncated: boolean } {
  if (value.length <= MAX_CELL_CHARS) return { value, truncated: false };
  return { value: `${value.slice(0, MAX_CELL_CHARS - 1)}…`, truncated: true };
}

function boundedValue(value: unknown): { value: unknown; truncated: boolean } {
  if (typeof value === "string") return truncateText(value);
  if (value === null || typeof value !== "object") return { value, truncated: false };
  const text = JSON.stringify(value);
  if (text === undefined) return { value: String(value), truncated: false };
  const clipped = truncateText(text);
  return { value: clipped.value, truncated: clipped.truncated };
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf-8");
}

export function boundRows(rawRows: unknown[][], maxRows: number): BoundedRows {
  const rows: unknown[][] = [];
  const warnings: string[] = [];
  let truncated = rawRows.length > maxRows;
  let currentBytes = 0;

  for (const rawRow of rawRows.slice(0, maxRows)) {
    const row: unknown[] = [];
    let clippedCell = false;
    for (const cell of rawRow) {
      const bounded = boundedValue(cell);
      row.push(bounded.value);
      clippedCell ||= bounded.truncated;
    }
    const rowBytes = bytes(row);
    if (currentBytes + rowBytes > MAX_RESULT_BYTES) {
      truncated = true;
      break;
    }
    currentBytes += rowBytes;
    rows.push(row);
    if (clippedCell) truncated = true;
  }

  if (rawRows.length > maxRows) warnings.push(`Result was limited to ${maxRows} rows.`);
  if (rows.length < Math.min(rawRows.length, maxRows)) warnings.push(`Result was limited to ${MAX_RESULT_BYTES} bytes.`);
  if (truncated && !warnings.some((warning) => warning.includes("bytes")) && rows.length === Math.min(rawRows.length, maxRows)) {
    warnings.push(`Individual cell values were limited to ${MAX_CELL_CHARS} characters.`);
  }
  return { rows, truncated, warnings };
}

export function boundTableNames(names: string[]): { tables: string[]; truncated: boolean } {
  return {
    tables: names.slice(0, MAX_TABLE_RESULTS),
    truncated: names.length > MAX_TABLE_RESULTS
  };
}

export function boundItems<T>(items: T[], maxItems = MAX_TABLE_RESULTS): { items: T[]; truncated: boolean } {
  const bounded: T[] = [];
  let currentBytes = 0;
  for (const item of items.slice(0, maxItems)) {
    const itemBytes = bytes(item);
    if (currentBytes + itemBytes > MAX_RESULT_BYTES) break;
    currentBytes += itemBytes;
    bounded.push(item);
  }
  return { items: bounded, truncated: bounded.length < items.length };
}

export const resultLimits = {
  maxBytes: MAX_RESULT_BYTES,
  maxCellChars: MAX_CELL_CHARS,
  maxTables: MAX_TABLE_RESULTS
};
