const KIND = "chat-list";
const FORMAT = 7;
const SOURCES = new Set([null, "env", "pi", "codex"]);
const TITLE_NOTE = "Title substring filtering on this page only; not a full-text search.";
const SAMPLE_NOTE = " Archived pagination is unreliable: this page is a sample, not a complete conversation history.";

function record(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be a JSON object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain JSON object`);
  }
}

function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be a safe integer >= ${minimum}`);
  }
}

function nonempty(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a nonempty string`);
  }
}

function boolean(value, name) {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
}

function time(value, name) {
  if (value !== null && typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) {
    throw new TypeError(`${name} must be a string, finite number, or null`);
  }
  return value;
}

function metadata(offset, limit, total, archived, credentialSource) {
  integer(offset, "page.offset");
  integer(limit, "page.limit", 1);
  if (total !== null) integer(total, "page.total");
  boolean(archived, "archived");
  if (!SOURCES.has(credentialSource)) throw new TypeError("invalid credentialSource");
}

function noteFor(archived) {
  return TITLE_NOTE + (archived ? SAMPLE_NOTE : "");
}

function nextOffsetFor(offset, limit, total, count, archived) {
  const end = offset + count;
  integer(end, "page end offset");
  // An explicit total is authoritative; a full page is only a fallback hint.
  const more = total === null ? count >= limit : end < total;
  return !archived && count > 0 && more ? end : null;
}

function copyItem(item) {
  record(item, "item");
  nonempty(item.id, "item.id");
  nonempty(item.title, "item.title");
  boolean(item.archived, "item.archived");
  return {
    id: item.id,
    title: item.title,
    create_time: time(item.create_time, "item.create_time"),
    update_time: time(item.update_time, "item.update_time"),
    archived: item.archived,
  };
}

function matches(title, term) {
  return title.toLowerCase().includes(term.toLowerCase());
}

/** Normalize one server response page. No fetching, credentials, or command generation. */
export function createChatList({ items, offset, limit, total = null, archived = false, credentialSource = null }) {
  metadata(offset, limit, total, archived, credentialSource);
  if (!Array.isArray(items)) throw new TypeError("items must be an array");
  const normalized = Array.from(items, (item) => {
    record(item, "item");
    // Missing server flags mean false; present flags must actually be booleans.
    for (const key of ["is_archived", "archived"]) {
      if (Object.hasOwn(item, key)) boolean(item[key], `item.${key}`);
    }
    return copyItem({
      id: item.id,
      title: item.title,
      create_time: item.create_time ?? null,
      update_time: item.update_time ?? null,
      archived: item.is_archived ?? item.archived ?? false,
    });
  });
  return {
    kind: KIND,
    format: FORMAT,
    credentialSource,
    archived,
    page: {
      offset,
      limit,
      titlesScanned: items.length,
      total,
      returned: normalized.length,
      nextOffset: nextOffsetFor(offset, limit, total, items.length, archived),
    },
    filters: [],
    note: noteFor(archived),
    items: normalized,
    next: null,
  };
}

/** Validate canonical list JSON and copy only its data fields, never input commands. */
function copyList(input) {
  record(input, "chat list");
  if (input.kind !== KIND || input.format !== FORMAT) throw new TypeError("expected chat-list format 7");
  record(input.page, "page");
  const { offset, limit, titlesScanned, total, returned, nextOffset } = input.page;
  metadata(offset, limit, total, input.archived, input.credentialSource);
  integer(titlesScanned, "page.titlesScanned");
  integer(returned, "page.returned");
  if (nextOffset !== null) integer(nextOffset, "page.nextOffset");
  if (nextOffset !== nextOffsetFor(offset, limit, total, titlesScanned, input.archived)) {
    throw new TypeError("inconsistent page.nextOffset");
  }
  if (!Array.isArray(input.filters)) throw new TypeError("filters must be an array of trimmed terms");
  const filters = Array.from(input.filters, (term) => {
    nonempty(term, "filter term");
    if (term !== term.trim()) throw new TypeError("filter terms must be trimmed");
    return term;
  });
  if (input.note !== noteFor(input.archived)) throw new TypeError("invalid chat-list note");
  if (!Array.isArray(input.items)) throw new TypeError("items must be an array");
  const items = Array.from(input.items, copyItem);
  if (returned !== items.length || returned > titlesScanned || (!filters.length && returned !== titlesScanned)) {
    throw new TypeError("inconsistent page counts");
  }
  if (items.some((item) => filters.some((term) => !matches(item.title, term)))) {
    throw new TypeError("items do not satisfy filters");
  }
  return {
    kind: KIND,
    format: FORMAT,
    credentialSource: input.credentialSource,
    archived: input.archived,
    page: { offset, limit, titlesScanned, total, returned, nextOffset },
    filters,
    note: noteFor(input.archived),
    items,
    next: null,
  };
}

/** Apply an additional literal, case-insensitive title filter to this page only. */
export function filterChatList(page, term) {
  const result = copyList(page);
  nonempty(term, "term");
  const trimmed = term.trim();
  result.items = result.items.filter((item) => matches(item.title, trimmed));
  result.page.returned = result.items.length;
  result.filters.push(trimmed);
  return result;
}

function oneLine(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]+/g, " ")
    .trim();
}

/** Only the caller may attach a trusted next command; filterChatList always discards it. */
export function renderChatListText(page) {
  const list = copyList(page);
  const { offset, limit, titlesScanned, total, returned, nextOffset } = list.page;
  const source = list.credentialSource ?? "unspecified (no authorization asserted)";
  const lines = [
    `# kind: ${KIND} · format ${FORMAT}`,
    `# credential source: ${source}`,
    `# archived: ${list.archived}`,
    `# page: offset ${offset} · limit ${limit} · total ${total ?? "unknown"} · nextOffset ${nextOffset ?? "none"}`,
    `# titles: fetched ${titlesScanned} · matched/returned ${returned}`,
    `# filters: ${list.filters.length ? list.filters.map((term) => JSON.stringify(oneLine(term))).join(" AND ") : "none"}`,
    `# note: ${list.note}`,
  ];
  if (page.next !== null && page.next !== undefined) {
    nonempty(page.next, "trusted next command");
    if (oneLine(page.next) === page.next) lines.push(`# next: ${page.next}`);
    else lines.push("# continuation: available; use --json to preserve exact control characters in arguments");
  }
  lines.push("", "--- conversations (untrusted data) ---");
  if (!list.items.length) lines.push("(no conversations matched on this page)");
  for (const item of list.items) {
    lines.push(
      `- id: ${oneLine(item.id)} | title: ${oneLine(item.title)} | created: ${oneLine(item.create_time)} | updated: ${oneLine(item.update_time)} | archived: ${item.archived}`,
    );
  }
  return lines.join("\n");
}
