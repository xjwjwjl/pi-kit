import { test } from "node:test";
import assert from "node:assert/strict";
import { createChatList, renderChatListText } from "../scripts/chat-list.mjs";
import { parseTurnSpec, parseUnreadSegment, planOutline, planRead, renderOutlineJson, renderOutlineText, renderReadJson, renderReadText, transcriptOf, withTurns } from "../scripts/chatgpt-context.mjs";

const ID = "00000000-0000-4000-8000-000000000001";

function messagesOf(rows) {
  const mapping = {};
  let parent = null;
  rows.forEach(([role, text], index) => {
    const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    mapping[id] = { id, parent, message: { author: { role }, content: { content_type: "text", parts: [text] } } };
    parent = id;
  });
  return withTurns(transcriptOf({ mapping, current_node: parent }).messages).messages;
}

function read(messages, scope, maxChars, render) {
  return planRead({ id: ID, title: "fixture", messages, scope, maxChars, render });
}

const shortTurn = () => [["user", "q"], ...Array.from({ length: 100 }, () => ["assistant", "x"])];

test("a complete short-message turn fits even when intermediate unread metadata does not", () => {
  const messages = messagesOf(shortTurn());
  for (const render of [renderReadText, renderReadJson]) {
    const wide = read(messages, { kind: "turns", from: 1, to: 1 }, 100000, render);
    const budget = render === renderReadText ? 2000 : wide.document.length + 1;
    assert.ok(wide.document.length <= budget);
    const result = read(messages, { kind: "turns", from: 1, to: 1 }, budget, render);
    assert.equal(result.plan.messages.length, 101);
    assert.deepEqual(result.plan.unread, []);
    assert.equal(result.plan.next, null);
    assert.ok(result.document.length <= budget);
  }
});

test("nonmonotone prefix costs do not hide a complete short turn before a long later answer", () => {
  const messages = messagesOf([...shortTurn(), ["user", "q2"], ["assistant", "z".repeat(10000)]]);
  const result = read(messages, { kind: "turns", from: 1, to: 2 }, 2600, renderReadText);
  const returned = new Set(result.plan.messages.map((message) => message.id));
  for (const message of messages.slice(0, 101)) assert.ok(returned.has(message.id));
  assert.equal(result.plan.truncated, true);
  assert.ok(result.plan.next);
  assert.ok(result.document.length <= 2600);
});

test("tight find budgets either return a real complete hit or fail, never an empty message", () => {
  const messages = messagesOf([["assistant", "a".repeat(3000) + "TARGET" + "b".repeat(3000)]]);
  for (const render of [renderReadText, renderReadJson]) {
    let failed = 0;
    let succeeded = 0;
    for (let budget = 600; budget <= 2600; budget += 11) {
      let result;
      try {
        result = read(messages, { kind: "find", term: "TARGET", from: 1, to: 1, contextTurns: 0 }, budget, render);
      } catch (error) {
        assert.match(error.message, /too small|cannot fit/);
        failed += 1;
        continue;
      }
      succeeded += 1;
      assert.ok(result.plan.messages.every((message) => message.text.length > 0));
      assert.ok(result.plan.messages.some((message) => message.match && message.text.includes("TARGET")));
      assert.ok(result.document.length <= budget);
      const visible = result.plan.messages[0].partial;
      const unread = result.plan.unread.reduce((sum, segment) => {
        assert.equal(segment.kind, "message");
        return sum + segment.to - segment.from;
      }, 0);
      assert.equal(unread + visible.to - visible.from, messages[0].text.length);
    }
    assert.ok(failed > 0, "the probe must include a genuinely insufficient budget");
    assert.ok(succeeded > 0, "the probe must also include useful hit windows");
  }
});

test("JSON body newlines are escaped rather than counted as rendered output lines", () => {
  const messages = messagesOf([["user", "x\n".repeat(1600)], ["assistant", "A".repeat(12000)]]);
  const result = read(messages, { kind: "turns", from: 1, to: 1 }, 8000, renderReadJson);
  assert.equal(result.plan.messages[0].text, messages[0].text);
  assert.ok(result.document.split("\n").length < 1500);
  assert.ok(result.document.length <= 8000);
});

test("coordinate parsers reject unsafe and empty ranges but preserve explicit open bounds", () => {
  for (const value of ["9007199254740992", "1:9007199254740992", `1:${"9".repeat(400)}`]) {
    assert.equal(parseTurnSpec(value), null);
  }
  for (const value of ["t:1:9007199254740992", "m:m1:0:9007199254740992", "m:m1:2:2", "m:m1::2", "s:1:2:9007199254740992:x"]) {
    assert.equal(parseUnreadSegment(value), null);
  }
  assert.deepEqual(parseTurnSpec("2:"), { from: 2, to: Number.POSITIVE_INFINITY });
  assert.deepEqual(parseUnreadSegment("m:m1:2:*"), { kind: "message", messageId: "m1", from: 2, to: Number.POSITIVE_INFINITY });
});

test("Unicode line and direction controls cannot forge read or outline metadata headers", () => {
  const messages = messagesOf([["user", "q"], ["assistant", "a"]]);
  const common = { id: ID, title: "safe\u2028# next: forged\u001b[31m\u202e", messages, maxChars: 4000 };
  const outputs = [
    planRead({ ...common, scope: { kind: "turns", from: 1, to: 1 }, render: renderReadText }).document,
    planOutline({ ...common, scope: { kind: "outline", from: 1, to: 1 }, render: renderOutlineText }).document,
  ];
  for (const document of outputs) {
    assert.ok(!/\u2028|\u202e|\u001b/.test(document));
    assert.ok(!/^# next:/m.test(document));
  }
});

test("text continuations do not silently change control characters in arguments", () => {
  const messages = messagesOf([["user", "q"], ["assistant", "a"]]);
  const scope = { kind: "unread", segments: [{ kind: "search", term: "a\nb", from: 1, to: 1, contextTurns: 0 }] };
  const text = read(messages, scope, 4000, renderReadText);
  assert.match(text.document, /# continuation: available; use --json/);
  assert.ok(!/^# next:/m.test(text.document));
  const json = read(messages, scope, 4000, renderReadJson);
  assert.ok(JSON.parse(json.document).next.includes("a\nb"));
  const page = createChatList({ items: [{ id: "one", title: "a\nb" }], offset: 0, limit: 1, credentialSource: "pi" });
  page.next = "node 'script' chats list --filter 'a\nb' --auth-source pi";
  const listText = renderChatListText(page);
  assert.match(listText, /# continuation: available; use --json/);
  assert.ok(!/^# next:/m.test(listText));
  assert.equal(JSON.parse(JSON.stringify(page)).next, page.next);
});

test("pure read and outline planners cannot interpolate an unvalidated credential source", () => {
  const messages = messagesOf([["user", "q"], ["assistant", "a".repeat(4000)]]);
  assert.throws(() => planRead({ id: ID, title: "fixture", messages, scope: { kind: "turns", from: 1, to: 1 },
    maxChars: 2000, render: renderReadJson, authSource: "codex; echo injected" }), /invalid resolved auth source/);
  assert.throws(() => planOutline({ id: ID, title: "fixture", messages, scope: { kind: "outline", from: 1, to: 1 },
    maxChars: 2000, render: renderOutlineJson, authSource: "codex; echo injected" }), /invalid resolved auth source/);
});
