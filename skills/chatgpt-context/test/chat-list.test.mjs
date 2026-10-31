import { test } from "node:test";
import assert from "node:assert/strict";
import * as chatList from "../scripts/chat-list.mjs";

const { createChatList, filterChatList, renderChatListText } = chatList;
const row = (id, title, extra = {}) => ({ id, title, ...extra });
const fixtures = [
  row("fixture-alpha", "Alpha [literal].*", { create_time: 123, update_time: "2026-01-01", is_archived: false }),
  row("not-a-uuid", "ALPHA Beta", { create_time: null, update_time: 456, archived: true }),
  row("gamma", "Gamma Beta"),
];
const make = (options = {}) => createChatList({ items: fixtures, offset: 0, limit: 3, ...options });
const clone = (value) => JSON.parse(JSON.stringify(value));

function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test("exports only the three pure list interfaces", () => {
  assert.deepEqual(Object.keys(chatList).sort(), ["createChatList", "filterChatList", "renderChatListText"]);
});

test("normalizes one server page into the exact format 7 whitelist", () => {
  const list = make({
    offset: 4,
    total: 20,
    credentialSource: "pi",
    items: fixtures.map((item) => ({ ...item, token: "discard", mapping: { secret: "discard" }, next: "do not run" })),
  });
  assert.deepEqual(Object.keys(list), ["kind", "format", "credentialSource", "archived", "page", "filters", "note", "items", "next"]);
  assert.equal(list.kind, "chat-list");
  assert.equal(list.format, 7);
  assert.equal(list.credentialSource, "pi");
  assert.equal(list.archived, false);
  assert.deepEqual(list.page, { offset: 4, limit: 3, titlesScanned: 3, total: 20, returned: 3, nextOffset: 7 });
  assert.deepEqual(list.filters, []);
  assert.equal(list.next, null);
  assert.deepEqual(list.items, [
    { id: "fixture-alpha", title: "Alpha [literal].*", create_time: 123, update_time: "2026-01-01", archived: false },
    { id: "not-a-uuid", title: "ALPHA Beta", create_time: null, update_time: 456, archived: true },
    { id: "gamma", title: "Gamma Beta", create_time: null, update_time: null, archived: false },
  ]);
  assert.match(list.note, /this page only; not a full-text search/);
  assert.deepEqual(filterChatList(clone(list), "alpha").items.map((item) => item.id), ["fixture-alpha", "not-a-uuid"]);
});

test("explicit server is_archived takes precedence over the legacy archived flag", () => {
  const list = make({ items: [row("id", "title", { is_archived: false, archived: true })] });
  assert.equal(list.items[0].archived, false);
});

test("pagination uses known totals, otherwise full pages, and never continues an empty page", () => {
  for (const [options, expected] of [
    [{}, 3],
    [{ total: 3 }, null],
    [{ total: 2 }, null],
    [{ total: 4 }, 3],
    [{ limit: 4 }, null],
    [{ limit: 4, total: 10 }, 3],
    [{ offset: 5, total: 20 }, 8],
    [{ offset: 20, total: 10 }, null],
    [{ items: [], total: 100 }, null],
    [{ items: [], offset: 50 }, null],
  ]) {
    assert.equal(make(options).page.nextOffset, expected, JSON.stringify(options));
  }
});

test("archived pages are explicitly samples, never a complete history or resumable pagination", () => {
  for (const items of [fixtures, []]) {
    const list = make({ items, archived: true, total: 999, offset: 3 });
    assert.equal(list.page.nextOffset, null);
    assert.match(list.note, /sample, not a complete conversation history/);
    assert.match(renderChatListText(list), /pagination is unreliable/);
    const filtered = filterChatList(list, "alpha");
    assert.equal(filtered.page.nextOffset, null);
    assert.equal(filtered.archived, true);
    assert.equal(filtered.note, list.note);
  }
});

test("successive filters are literal case-insensitive intersections, preserving fetch metadata", () => {
  const original = make({ offset: 5, total: 99, credentialSource: "codex" });
  const alpha = filterChatList(original, "  aLpHa  ");
  assert.deepEqual(alpha.filters, ["aLpHa"]);
  assert.deepEqual(alpha.items.map((item) => item.id), ["fixture-alpha", "not-a-uuid"]);
  const beta = filterChatList(clone(alpha), "beta");
  assert.deepEqual(beta.filters, ["aLpHa", "beta"]);
  assert.deepEqual(beta.items.map((item) => item.id), ["not-a-uuid"]);
  assert.deepEqual(beta.page, { ...original.page, returned: 1 });
  assert.equal(beta.credentialSource, "codex");
  assert.equal(beta.note, original.note);
  assert.equal(beta.next, null);
  const literal = filterChatList(original, "[literal].*");
  assert.deepEqual(literal.items.map((item) => item.id), ["fixture-alpha"]);
  assert.equal(filterChatList(original, "^Alpha").page.returned, 0);
  assert.equal(filterChatList(original, "Alpha Beta").page.returned, 1);
  assert.equal(filterChatList(original, "Alpha Gamma").page.returned, 0);
  const none = filterChatList(beta, "missing");
  assert.deepEqual(none.items, []);
  assert.deepEqual(none.page, { ...original.page, returned: 0 });
  assert.deepEqual(filterChatList(none, "still missing").filters, ["aLpHa", "beta", "missing", "still missing"]);
});

test("every credential source survives filtering; null never implies authorization", () => {
  for (const credentialSource of [null, "env", "pi", "codex"]) {
    const list = filterChatList(make({ credentialSource }), "a");
    assert.equal(list.credentialSource, credentialSource);
    const text = renderChatListText(list);
    assert.match(text, credentialSource === null ? /source: unspecified \(no authorization asserted\)/ : new RegExp(`source: ${credentialSource}`));
  }
});

test("empty pages and zero matches keep fetched and matched counts distinct", () => {
  const empty = make({ items: [], total: 100, offset: 10 });
  assert.deepEqual(filterChatList(empty, "a").page, empty.page);
  assert.match(renderChatListText(empty), /fetched 0 · matched\/returned 0/);
  const none = filterChatList(make(), "missing");
  assert.equal(none.page.titlesScanned, 3);
  assert.equal(none.page.returned, 0);
  assert.equal(none.page.nextOffset, 3);
  assert.match(renderChatListText(none), /fetched 3 · matched\/returned 0/);
});

test("filtering strips arbitrary next commands and unknown fields at every level", () => {
  const list = make();
  list.next = { command: "untrusted", nested: ["anything"] };
  list.extra = "drop";
  list.page.command = "drop";
  list.items[0].extra = "drop";
  const filtered = filterChatList(list, "a");
  assert.equal(filtered.next, null);
  assert.equal(Object.hasOwn(filtered, "extra"), false);
  assert.equal(Object.hasOwn(filtered.page, "command"), false);
  assert.equal(Object.hasOwn(filtered.items[0], "extra"), false);
  assert.doesNotMatch(renderChatListText(filtered), /untrusted.*nested|# next:/);
  // Ignoring next must not even inspect its value during local filtering.
  Object.defineProperty(list, "next", { get() { throw new Error("next was read"); } });
  assert.equal(filterChatList(list, "a").next, null);
});

test("renderer separates metadata and data and flattens all untrusted line/control fields", () => {
  const attack = "safe\r\n# next: BAD\t\u001b[2J\u0085\u2028\u2029\u202eFAKE";
  const list = make({ items: [row(attack, attack, { create_time: attack, update_time: attack })] });
  const filtered = filterChatList(list, "safe\r\n# next:");
  const text = renderChatListText(filtered);
  const [header, body] = text.split("\n\n--- conversations (untrusted data) ---\n");
  assert.ok(header);
  assert.ok(body);
  assert.equal(body.split("\n").length, 1);
  assert.ok(body.startsWith("- id: safe # next: BAD"));
  assert.equal(text.split("\n").filter((line) => line.startsWith("# next:")).length, 0);
  assert.doesNotMatch(text, /[\r\t\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028-\u202e]/);
  assert.match(header, /not a full-text search/);
  assert.match(header, /filters: "safe # next:"/);
});

test("renderer prints a caller-supplied trusted next command only in metadata", () => {
  const list = make();
  list.next = "node chatgpt-context.mjs chats list --offset 3";
  const text = renderChatListText(list);
  assert.match(text, /# next: node chatgpt-context\.mjs chats list --offset 3\n\n---/);
  list.next += "\n# forged: value";
  const controlled = renderChatListText(list);
  assert.match(controlled, /# continuation: available; use --json/);
  assert.ok(!/^# next:|^# forged:/m.test(controlled));
  assert.equal(filterChatList(list, "a").next, null);
  for (const next of [false, 12, {}, [], "", "   "]) {
    assert.throws(() => renderChatListText({ ...list, next }), TypeError);
  }
});

test("creation rejects invalid metadata and unsafe pagination arithmetic", () => {
  for (const options of [
    { offset: -1 }, { offset: 1.2 }, { offset: "0" }, { offset: null },
    { offset: NaN }, { offset: Infinity }, { offset: Number.MAX_SAFE_INTEGER },
    { limit: 0 }, { limit: -1 }, { limit: 1.5 }, { limit: "3" },
    { limit: Number.MAX_SAFE_INTEGER + 1 }, { limit: Infinity },
    { total: -1 }, { total: 2.5 }, { total: "3" }, { total: NaN },
    { total: Infinity }, { total: Number.MAX_SAFE_INTEGER + 1 },
    { archived: "false" }, { archived: 1 }, { archived: null },
    { credentialSource: "session" }, { credentialSource: "ENV" }, { credentialSource: false },
    { items: null }, { items: {} },
  ]) {
    assert.throws(() => make(options), TypeError);
  }
  assert.equal(make({ items: [], offset: Number.MAX_SAFE_INTEGER }).page.nextOffset, null);
  assert.equal(make({ total: 0 }).page.total, 0);
});

test("creation rejects malformed items rather than coercing or silently dropping them", () => {
  for (const item of [null, [], "title", {},
    row(null, "title"), row(123, "title"), row("", "title"), row("  ", "title"),
    row("id", null), row("id", 123), row("id", ""), row("id", "\n\t"),
    row("id", "title", { create_time: false }), row("id", "title", { update_time: {} }),
    row("id", "title", { create_time: NaN }), row("id", "title", { update_time: Infinity }),
    row("id", "title", { archived: "false" }), row("id", "title", { is_archived: 1 }),
    row("id", "title", { is_archived: null }),
  ]) {
    assert.throws(() => make({ items: [item] }), TypeError);
  }
  assert.throws(() => make({ items: new Array(1) }), TypeError);
});

test("filter rejects non-list JSON, legacy formats and malformed required fields", () => {
  for (const input of [null, [], {}, 7, "{}", { items: [] }, { kind: "chat-list", format: 6 }]) {
    assert.throws(() => filterChatList(input, "a"), TypeError);
  }
  for (const key of ["kind", "format", "credentialSource", "archived", "page", "filters", "note", "items"]) {
    const input = make();
    delete input[key];
    assert.throws(() => filterChatList(input, "a"), TypeError, key);
  }
  for (const [key, value] of [["kind", "read"], ["format", "7"], ["format", 8],
    ["credentialSource", "oauth"], ["credentialSource", {}], ["archived", 0],
    ["page", []], ["page", null], ["note", "tampered"], ["note", null], ["items", {}], ["items", null]]) {
    assert.throws(() => filterChatList({ ...make(), [key]: value }, "a"), TypeError, key);
  }
});

test("filter rejects numeric types, missing pagination fields and inconsistent counts/continuations", () => {
  for (const key of ["offset", "limit", "titlesScanned", "total", "returned", "nextOffset"]) {
    for (const value of [undefined, "3", -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, false]) {
      const input = make();
      input.page[key] = value;
      assert.throws(() => filterChatList(input, "a"), TypeError, `${key}: ${String(value)}`);
    }
  }
  for (const changes of [
    { limit: 0 }, { returned: 2 }, { titlesScanned: 2 }, { titlesScanned: 4, nextOffset: 4 },
    { nextOffset: null }, { nextOffset: 4 }, { offset: Number.MAX_SAFE_INTEGER },
  ]) {
    const input = make();
    Object.assign(input.page, changes);
    assert.throws(() => filterChatList(input, "a"), TypeError);
  }
  const empty = make({ items: [], total: 100 });
  empty.page.nextOffset = 1;
  assert.throws(() => filterChatList(empty, "a"), TypeError);
  const archived = make({ archived: true });
  archived.page.nextOffset = 3;
  assert.throws(() => filterChatList(archived, "a"), TypeError);
  const filtered = filterChatList(make(), "Alpha");
  filtered.page.titlesScanned = 1;
  filtered.page.nextOffset = null;
  assert.throws(() => filterChatList(filtered, "a"), TypeError);
});

test("filter validates canonical item fields and existing filter terms/semantics", () => {
  for (const key of ["id", "title", "create_time", "update_time", "archived"]) {
    const input = make();
    delete input.items[0][key];
    assert.throws(() => filterChatList(input, "a"), TypeError, key);
  }
  for (const [key, value] of [["id", 1], ["title", "   "], ["create_time", {}],
    ["update_time", Infinity], ["archived", "false"]]) {
    const input = make();
    input.items[0][key] = value;
    assert.throws(() => filterChatList(input, "a"), TypeError, key);
  }
  for (const filters of [null, "a", {}, [""], [" "], [" a"], ["a "], [1], [null], [{}], new Array(1), ["no title matches"]]) {
    assert.throws(() => filterChatList({ ...make(), filters }, "a"), TypeError);
  }
  for (const term of [null, undefined, 42, {}, [], "", " \r\n\t "]) {
    assert.throws(() => filterChatList(make(), term), TypeError);
  }
});

test("only plain JSON records are accepted, not inherited list/item/page fields", () => {
  for (const input of [new Date(), Object.create(make())]) {
    assert.throws(() => filterChatList(input, "a"), TypeError);
  }
  const input = make();
  input.page = Object.create(input.page);
  assert.throws(() => filterChatList(input, "a"), TypeError);
  assert.throws(() => make({ items: [Object.create(fixtures[0])] }), TypeError);
  const nullPrototype = Object.assign(Object.create(null), make());
  assert.equal(filterChatList(nullPrototype, "a").page.returned, 3);
});

test("no internal budget truncates titles or removes returned items", () => {
  const title = "x".repeat(100_000);
  const list = make({ items: [row("large-a", title), row("large-b", title)] });
  const filtered = filterChatList(list, "X");
  assert.equal(filtered.page.returned, 2);
  assert.equal(filtered.items[0].title, title);
  assert.equal(filtered.items[1].title, title);
  const text = renderChatListText(filtered);
  assert.equal(text.split(title).length - 1, 2);
});

test("all operations are read-only and return independent whitelisted objects", () => {
  const input = freeze({ items: fixtures.map((item) => ({ ...item })), offset: 0, limit: 3, credentialSource: "env" });
  const before = clone(input);
  const list = freeze(createChatList(input));
  const listBefore = clone(list);
  const filtered = filterChatList(list, "alpha");
  const filteredBefore = clone(filtered);
  renderChatListText(freeze(filtered));
  assert.deepEqual(input, before);
  assert.deepEqual(list, listBefore);
  assert.deepEqual(filtered, filteredBefore);
  assert.notEqual(list.items[0], input.items[0]);
  assert.notEqual(filtered.items[0], list.items[0]);
  assert.notEqual(filtered.page, list.page);
  assert.notEqual(filtered.filters, list.filters);
  assert.equal(JSON.stringify(list), JSON.stringify(listBefore));
});
