export function normalizeSql(statement: string): string {
  let normalized = statement.trim();
  while (true) {
    const previous = normalized;
    normalized = normalized
      .replace(/\s+$/g, "")
      .replace(/(?:--|#)[^\r\n]*$/g, "")
      .replace(/\/\*[\s\S]*?\*\/\s*$/g, "")
      .replace(/;+\s*$/g, "")
      .trim();
    if (normalized === previous) return normalized;
  }
}

export function hasMultipleStatements(statement: string): boolean {
  let quote: "'" | '"' | "`" | null = null;
  let blockComment = false;
  let lineComment = false;

  for (let index = 0; index < statement.length; index++) {
    const char = statement[index];
    const next = statement[index + 1];
    const previous = statement[index - 1];

    if (lineComment) {
      if (char === "\n" || char === "\r") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (char === quote && previous !== "\\") quote = null;
      continue;
    }
    if (char === "-" && next === "-") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "#") {
      lineComment = true;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === ";" && statement.slice(index + 1).trim() !== "") return true;
  }

  return false;
}

const STATEMENT_KEYWORDS = new Set([
  "SELECT",
  "SHOW",
  "DESCRIBE",
  "DESC",
  "EXISTS",
  "EXPLAIN",
  "INSERT",
  "UPDATE",
  "DELETE",
  "REPLACE",
  "CREATE",
  "ALTER",
  "DROP",
  "TRUNCATE",
  "RENAME",
  "GRANT",
  "REVOKE",
  "SET",
  "USE",
  "CALL",
  "SYSTEM",
  "KILL",
  "OPTIMIZE",
  "ATTACH",
  "DETACH",
  "BACKUP",
  "RESTORE"
]);

export function firstKeyword(statement: string): string | undefined {
  const normalized = normalizeSql(statement);
  let quote: "'" | '"' | "`" | null = null;
  let blockComment = false;
  let lineComment = false;
  let depth = 0;
  let sawWith = false;

  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index];
    const next = normalized[index + 1];
    const previous = normalized[index - 1];

    if (lineComment) {
      if (char === "\n" || char === "\r") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (char === quote && previous !== "\\") quote = null;
      continue;
    }
    if (char === "-" && next === "-") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "#") {
      lineComment = true;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (depth > 0 || !/[A-Za-z_]/.test(char)) continue;

    let end = index + 1;
    while (end < normalized.length && /[A-Za-z0-9_$]/.test(normalized[end])) end += 1;
    const word = normalized.slice(index, end).toUpperCase();
    index = end - 1;
    if (!sawWith) {
      if (word !== "WITH") return word;
      sawWith = true;
      continue;
    }
    if (STATEMENT_KEYWORDS.has(word)) return word;
  }

  return sawWith ? "WITH" : undefined;
}

export function hasTopLevelKeyword(statement: string, keyword: string): boolean {
  let quote: "'" | '"' | "`" | null = null;
  let blockComment = false;
  let lineComment = false;
  let depth = 0;

  for (let index = 0; index < statement.length; index++) {
    const char = statement[index];
    const next = statement[index + 1];
    const previous = statement[index - 1];

    if (lineComment) {
      if (char === "\n" || char === "\r") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (char === quote && previous !== "\\") quote = null;
      continue;
    }
    if (char === "-" && next === "-") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "#") {
      lineComment = true;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (depth > 0 || !/[A-Za-z_]/.test(char)) continue;

    let end = index + 1;
    while (end < statement.length && /[A-Za-z0-9_$]/.test(statement[end])) end += 1;
    if (statement.slice(index, end).toUpperCase() === keyword) return true;
    index = end - 1;
  }

  return false;
}
