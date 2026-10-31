#!/usr/bin/env node
/**
 * chatgpt-context — read ChatGPT conversation context from a terminal or Pi.
 *
 * Credentials, in order of preference:
 *   1. CHATGPT_ACCESS_TOKEN environment variable
 *   2. Pi's ChatGPT OAuth entry: <PI_CODING_AGENT_DIR|~/.pi/agent>/auth.json
 *      -> openai-codex (refreshed through `pi auth print-bearer-token` when close
 *      to expiring; a selected source never falls back to another account)
 *   3. Codex's entry: <CODEX_HOME|~/.codex>/auth.json -> tokens.access_token
 *
 * Secrets never reach a command line: the Authorization header is handed to curl
 * through `-K -` on stdin, and error output is redacted. Read-only: only GET
 * requests are issued to chatgpt.com/backend-api, and the token is never printed.
 * Pi may refresh its credential store; optional image downloads replace local
 * files only after a successful download.
 *
 * The transport is `curl`, not Node's fetch: chatgpt.com answers Node's fetch
 * with a Cloudflare 403 (including with NODE_USE_ENV_PROXY=1), while curl is
 * accepted and honours HTTP(S)_PROXY / ALL_PROXY automatically.
 *
 * Commands: chats list/filter; chat outline/read/tail/find; auth whoami; help.
 * `read` selects the whole active branch; `tail` selects only its latest scope.
 * Local `chats filter --input FILE|-` never reads credentials or the network.
 *
 * See references/endpoints.md for the endpoint behaviour and known failure modes.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createChatList, filterChatList, renderChatListText } from "./chat-list.mjs";

const BASE = "https://chatgpt.com/backend-api";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const BOOLEAN_FLAGS = new Set(["json", "archived", "help", "include-tools"]);
const VALUE_FLAGS = new Set([
  "limit",
  "offset",
  "search",
  "last",
  "last-turns",
  "turns",
  "message",
  "until",
  "before",
  "context-turns",
  "unread",
  "max-chars",
  "images",
  "filter",
  "input",
  "count",
  "messages",
  "auth-source",
]);
/** Flags that collect a list of values instead of the last one seen. */
const REPEATABLE_FLAGS = new Set(["unread"]);
const OUTPUT_OPTIONS = ["json", "max-chars"];
const NETWORK_OPTIONS = [...OUTPUT_OPTIONS, "auth-source"];
const COMMAND_OPTIONS = {
  "chats list": new Set(["limit", "offset", "filter", "archived", ...NETWORK_OPTIONS]),
  "chats filter": new Set(["input", ...OUTPUT_OPTIONS]),
  "chat read": new Set(["turns", "message", "unread", "offset", "until", "before", "images", "include-tools", ...NETWORK_OPTIONS]),
  "chat tail": new Set(["count", "messages", "images", "include-tools", ...NETWORK_OPTIONS]),
  "chat find": new Set(["turns", "context-turns", "images", "include-tools", ...NETWORK_OPTIONS]),
  "chat outline": new Set(["turns", "include-tools", ...NETWORK_OPTIONS]),
  "auth whoami": new Set(NETWORK_OPTIONS),
};
const AUTH_SOURCES = new Set(["auto", "env", "pi", "codex"]);
const LEGACY_COMMANDS = {
  list: "chats list",
  search: "chats list --filter TERM (single-page titles only; server search is not implemented)",
  read: "chat read ID for the whole branch, or chat tail ID for the old latest-three-turn default; use tail --count/--messages instead of --last-turns/--last",
  outline: "chat outline ID",
  find: "chat find ID TERM",
  whoami: "auth whoami",
};
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 1000;
const DEFAULT_LIMIT = 30;
const DEFAULT_LAST_TURNS = 3;
const DEFAULT_MAX_CHARS = 16000;
/** A read must fit its metadata plus at least this much transcript. */
const MIN_BODY_CHARS = 200;
/** When a turn has to be trimmed, its opening message still gets this much. */
const BOUNDARY_QUESTION_CHARS = 300;
/** The output contract version, bumped whenever the envelope changes. */
const FORMAT_VERSION = 7;
/** The calling shell tool truncates near 2000 lines / 50 KB, so stay below it. */
const MAX_OUTPUT_BYTES = 40_000;
const MAX_OUTPUT_LINES = 1_500;
/** `next:` hints are complete commands so they can be run as printed. */
const SCRIPT_COMMAND = `node ${shellQuote(fileURLToPath(import.meta.url))}`;

/** POSIX-shell quoting: `next:` hints may carry user text such as a search term. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Flatten untrusted single-line fields (a ChatGPT title, a conversation id) before
 * they reach the `#`-prefixed header: a newline in a title would otherwise forge a
 * contract line such as `# next: …`.
 */
function oneLine(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]+/g, " ")
    .trim();
}

/**
 * An id interpolated into a `next:` hint. A plain token is left bare so the hint
 * stays readable; anything else (a tampered `conversation_id`) is quoted, so a
 * metacharacter can never start a second shell command.
 */
function hintId(value) {
  const id = oneLine(value);
  return /^[A-Za-z0-9._-]+$/.test(id) ? id : shellQuote(id);
}

/** Every renderer has to respect the character budget and the byte/line guards. */
function outputFits(document, maxChars) {
  if (document.length > maxChars) return false;
  if (Buffer.byteLength(document, "utf8") > MAX_OUTPUT_BYTES) return false;
  let lines = 0;
  for (let index = 0; index < document.length; index++) {
    if (document.charCodeAt(index) === 10 && ++lines >= MAX_OUTPUT_LINES) return false;
  }
  return true;
}

export function isConversationId(value) {
  return typeof value === "string" && /^[0-9a-fA-F-]{8,}$/.test(value.trim());
}

export function parseArgs(argv) {
  const positional = [];
  const opts = {};
  const unknown = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (/^-[^-]/.test(arg)) {
      unknown.push(arg);
      continue;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      opts[key] = true;
    } else if (VALUE_FLAGS.has(key)) {
      // A trailing value option, or one followed by another flag, is recorded as
      // null so the command can report it. The following flag is still parsed, so
      // `--images --json` cannot turn "--json" into a directory name.
      const next = argv[i + 1];
      const missing = next === undefined || next === "--" || isKnownFlag(next) || /^-[A-Za-z]/.test(next);
      if (!missing) i += 1;
      const entry = missing ? null : next;
      if (REPEATABLE_FLAGS.has(key)) opts[key] = [...(opts[key] ?? []), entry];
      // A later occurrence cannot hide an earlier option that lacked a value.
      else if (opts[key] !== null) opts[key] = entry;
    } else {
      unknown.push(key);
    }
  }
  return { positional, opts, unknown };
}

/** A token that names one of this CLI's own flags, not a value for the flag before it. */
function isKnownFlag(token) {
  if (typeof token !== "string" || !/^--[a-z]/i.test(token)) return false;
  const key = token.slice(2);
  return BOOLEAN_FLAGS.has(key) || VALUE_FLAGS.has(key);
}

/** Validate command-specific syntax before looking at any credential store. */
function validateCommandOptions(command, positional, opts, unknown) {
  if (unknown.length) {
    const names = unknown.map((name) => (name.startsWith("-") ? name : `--${name}`));
    fail(`unknown option(s): ${names.join(", ")}\n\n${HELP}`);
  }
  if (!Object.hasOwn(COMMAND_OPTIONS, command)) fail(`unknown command: ${command}\n\n${HELP}`);
  if (opts.images !== undefined && !["chat read", "chat tail", "chat find"].includes(command)) {
    fail("--images applies to chat read, chat tail and chat find only");
  }
  for (const [name, value] of Object.entries(opts)) {
    if (!COMMAND_OPTIONS[command].has(name)) fail(`--${name} does not apply to ${command}`);
    if (value === null || (Array.isArray(value) && value.includes(null))) {
      fail(`--${name} needs ${name === "images" ? "a directory" : "a value"}`);
    }
  }
  if (opts["auth-source"] !== undefined && !AUTH_SOURCES.has(opts["auth-source"])) {
    fail("--auth-source must be auto, env, pi or codex");
  }
  const minimum = command === "chat find" ? 3 : ["chats filter", "chat read", "chat tail", "chat outline"].includes(command) ? 2 : 1;
  const maximum = command === "chats filter" || command === "chat find" ? Number.POSITIVE_INFINITY : minimum;
  if (positional.length < minimum) fail(`usage: ${command} needs ${minimum - 1} argument(s)\n\n${HELP}`);
  if (positional.length > maximum) fail(`unexpected argument(s) for ${command}: ${JSON.stringify(positional.slice(maximum))}`);
}

/**
 * Read the active branch of a conversation, oldest first.
 *
 * Returns `{ messages, branch }`; `branch` is "current_node", "chronological" (a
 * linear parent chain with no usable pointer; the legacy label is retained),
 * or "empty". A tree that forks but has no
 * usable `current_node` cannot be resolved, so it throws instead of merging
 * branches into a transcript that was never a single conversation.
 */
export function transcriptOf(conversation) {
  const mapping = conversation?.mapping ?? {};
  const nodes = Object.values(mapping).filter((node) => node && typeof node === "object");
  if (!nodes.length) return { messages: [], branch: "empty" };

  const currentId = conversation?.current_node;
  const current = currentId && Object.hasOwn(mapping, currentId) ? mapping[currentId] : null;
  if (current && typeof current === "object") {
    const chain = [];
    const seen = new Set();
    let node = current;
    while (node) {
      if (seen.has(node)) {
        throw new Error("the current_node parent chain is cyclic; refusing to guess its order");
      }
      seen.add(node);
      if (node.message) chain.push(node);
      const parent = node.parent && Object.hasOwn(mapping, node.parent) ? mapping[node.parent] : null;
      if (node.parent && (!parent || typeof parent !== "object")) {
        throw new Error(`the current_node parent chain is missing parent ${oneLine(node.parent)}; refusing an incomplete branch`);
      }
      node = parent;
    }
    return { messages: chain.reverse().map(normalizeMessage).filter(Boolean), branch: "current_node" };
  }

  const children = new Map();
  for (const node of nodes) {
    if (node.parent) children.set(node.parent, (children.get(node.parent) ?? 0) + 1);
  }
  const forks = [...children.values()].filter((count) => count > 1).length;
  if (forks) {
    throw new Error(
      `the conversation offers no usable current_node and its message tree forks at ${forks} point(s), ` +
        "so the active branch cannot be determined; refusing to merge branches",
    );
  }

  // Timestamps may be equal, absent, or inconsistent; the unique parent chain
  // is the source of truth. Reject incomplete/disconnected trees instead of guessing.
  const roots = nodes.filter((node) => !node.parent);
  if (roots.length !== 1) throw new Error("the linear fallback needs exactly one root parent chain");
  const childByParent = new Map(nodes.filter((node) => node.parent).map((node) => [node.parent, node]));
  const ordered = [];
  const seen = new Set();
  let node = roots[0];
  while (node && !seen.has(node)) {
    seen.add(node);
    ordered.push(node);
    node = childByParent.get(node.id);
  }
  if (ordered.length !== nodes.length) {
    throw new Error("the linear parent chain is incomplete, disconnected, or cyclic; refusing to guess its order");
  }
  return { messages: ordered.map(normalizeMessage).filter(Boolean), branch: "chronological" };
}

/**
 * `sediment://file_x` and `file-service://file_x` both name a file the API can
 * download; the id is the part after the scheme. Anything else is not fetchable.
 */
function assetPointerId(pointer) {
  if (pointer == null) return null;
  const value = String(pointer).replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").trim();
  return /^[\w-]+$/.test(value) ? value : null;
}

const IMAGE_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/**
 * The local file name comes from the file id, so it is known before the download
 * and the budget search and the saved file always agree on one path.
 */
export function imageFileName(part) {
  const ext = IMAGE_EXTENSIONS[String(part.mime ?? "").toLowerCase()] ?? "png";
  return `${part.fileId}.${ext}`;
}

/** Untrusted pixel dimensions must not become arbitrary header text. */
function imageDimension(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** One message, with [image]/[attachment] placeholders for non-text parts. */
function normalizeMessage(node) {
  const message = node?.message;
  if (!message) return null;
  const parts = Array.isArray(message?.content?.parts) ? message.content.parts : [];
  const chunks = [];
  const imageParts = [];
  const imageRanges = [];
  let textLength = 0;
  const appendChunk = (chunk) => {
    const from = textLength + (chunks.length ? 1 : 0);
    chunks.push(chunk);
    textLength = from + chunk.length;
    return { from, to: textLength };
  };
  let images = 0;
  let attachments = 0;
  for (const part of parts) {
    if (typeof part === "string") {
      // Preserve whitespace parts; only the whole-message check below discards blank content.
      if (part.length) appendChunk(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const type = String(part.content_type ?? part.type ?? "");
    const pointer = part.asset_pointer ?? part.file_id ?? part.fileId;
    const asset = Boolean(pointer);
    if (/image/i.test(type)) {
      images += 1;
      const fileId = assetPointerId(pointer);
      imageRanges.push({ ...appendChunk("[image]"), fileId });
      if (fileId) {
        imageParts.push({
          fileId,
          mime: part.mime_type ?? null,
          width: imageDimension(part.width),
          height: imageDimension(part.height),
          sizeBytes: part.size_bytes ?? null,
        });
      }
    } else if (type || asset) {
      attachments += 1;
      appendChunk("[attachment]");
    }
    // A part with neither a type nor a payload carries nothing to report.
  }
  // Keep the original text: trimming would eat code indentation and trailing newlines.
  const text = chunks.join("\n");
  if (!text.trim()) return null;
  return {
    id: node.id,
    role: message?.author?.role ?? "unknown",
    contentType: message?.content?.content_type,
    text,
    images,
    attachments,
    imageParts,
    imageRanges,
  };
}

/** Group messages into turns: a turn starts at each user message. */
export function turnsOf(messages) {
  const turns = [];
  let current = null;
  for (const message of messages) {
    if (!current || (message.role === "user" && current.started)) {
      current = { index: turns.length + 1, started: false, messages: [] };
      turns.push(current);
    }
    if (message.role === "user") current.started = true;
    current.messages.push(message);
  }
  return turns.map(({ index, messages: turnMessages }) => ({ index, messages: turnMessages }));
}

/** Tag every message with its 1-based turn number. */
export function withTurns(messages) {
  const turns = turnsOf(messages);
  const tagged = [];
  for (const turn of turns) {
    for (const message of turn.messages) tagged.push({ ...message, turn: turn.index });
  }
  return { messages: tagged, turns };
}

/** Parse `--turns`: `N`, `N:M`, `N:`, or `:M` (1-based, inclusive). */
export function parseTurnSpec(value) {
  const match = /^(\d*)(?::(\d*))?$/.exec(String(value).trim());
  if (!match || (!match[1] && !match[2])) return null;
  const from = match[1] ? Number(match[1]) : 1;
  const to = match[2] === undefined ? from : match[2] ? Number(match[2]) : Number.POSITIVE_INFINITY;
  if (!Number.isSafeInteger(from) || from < 1) return null;
  if (match[2] && !Number.isSafeInteger(to)) return null;
  if (to !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(to) || to < from)) return null;
  return { from, to };
}

/**
 * The unread state is one ordered list of segments, so a follow-up never has to
 * infer a gap from read direction or turn numbers:
 *   `t:<from>:<to>`             whole turns (`*` = to the end)
 *   `m:<messageId>:<from>:<to>` one message window (`*` = to the message end)
 *   `s:<from>:<to>:<context>:<term>` a search still owed over those turns; it is
 *                              not readable content, so it rides along until the
 *                              read windows are done and then becomes a `find`
 *                              command. The term is the remainder, so it may
 *                              itself contain colons.
 */
export function parseUnreadSegment(spec) {
  const parts = String(spec ?? "").split(":");
  const number = (value) => {
    if (value === "*") return Number.POSITIVE_INFINITY;
    const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
  };
  if (parts[0] === "t" && parts.length === 3) {
    const from = number(parts[1]);
    const to = number(parts[2]);
    if (!Number.isInteger(from) || from < 1) return null;
    if (to !== Number.POSITIVE_INFINITY && (!Number.isInteger(to) || to < from)) return null;
    return { kind: "turns", from, to };
  }
  if (parts[0] === "m" && parts.length === 4) {
    const messageId = parts[1];
    const from = number(parts[2]);
    const to = number(parts[3]);
    if (!messageId || !Number.isInteger(from) || from < 0) return null;
    if (to !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(to) || to <= from)) return null;
    return { kind: "message", messageId, from, to };
  }
  if (parts[0] === "s" && parts.length >= 5) {
    const from = number(parts[1]);
    const to = number(parts[2]);
    const contextTurns = number(parts[3]);
    // The term is the remainder, so a term containing colons survives the round trip.
    const term = parts.slice(4).join(":");
    if (!term || !Number.isInteger(from) || from < 1) return null;
    if (to !== Number.POSITIVE_INFINITY && (!Number.isInteger(to) || to < from)) return null;
    if (!Number.isInteger(contextTurns) || contextTurns < 0) return null;
    return { kind: "search", term, from, to, contextTurns };
  }
  return null;
}

export function formatUnreadSegment(segment) {
  const bound = (value) => (value === Number.POSITIVE_INFINITY ? "*" : value);
  if (segment.kind === "turns") return `t:${segment.from}:${bound(segment.to)}`;
  if (segment.kind === "search") {
    return `s:${segment.from}:${bound(segment.to)}:${segment.contextTurns}:${segment.term}`;
  }
  return `m:${segment.messageId}:${segment.from}:${bound(segment.to)}`;
}

function segmentSpec(segment) {
  const spec = formatUnreadSegment(segment);
  return /^[\w.:*-]+$/.test(spec) ? spec : shellQuote(spec);
}

/**
 * What a follow-up still has to deliver, in document order. A cut message keeps
 * its own identity and bounds, so nothing is skipped or merged by guesswork.
 */
function unreadAfter(messages, selection, keptWindowByKey) {
  const fragments = [];
  // Continuation is restricted to the selected units, never an earlier prefix.
  for (const unit of selection.units) {
    const message = messages[unit.index];
    const windowTo = Math.min(unit.until, message.text.length);
    // Keyed by the unit, not the message: one message can carry a prefix and a
    // suffix window, and neither may overwrite the other.
    const kept = keptWindowByKey.get(`${unit.index}:${unit.start}:${windowTo}`);
    if (!kept) {
      fragments.push({
        messageId: message.id,
        from: unit.start,
        to: windowTo,
        turn: message.turn,
        whole: unit.start === 0 && windowTo >= message.text.length,
      });
      continue;
    }
    if (kept.from > unit.start) {
      fragments.push({ messageId: message.id, from: unit.start, to: kept.from, turn: message.turn, whole: false });
    }
    if (kept.to < windowTo) {
      fragments.push({
        messageId: message.id,
        from: kept.to,
        to: windowTo,
        turn: message.turn,
        whole: kept.to === 0 && windowTo >= message.text.length,
      });
    }
  }
  return compressFragments(fragments, messages, selection);
}

/** Runs of whole messages over complete turns collapse into one turn segment. */
function compressFragments(fragments, messages, selection) {
  // A `t:` segment re-selects every message of those turns, so it is only safe when
  // the run covers the whole turn in this conversation — never a partial selection.
  const allByTurn = new Map();
  for (const message of messages) {
    if (!allByTurn.has(message.turn)) allByTurn.set(message.turn, new Set());
    allByTurn.get(message.turn).add(message.id);
  }
  const segments = [];
  let index = 0;
  while (index < fragments.length) {
    const fragment = fragments[index];
    if (fragment.whole) {
      const turns = [fragment.turn];
      let end = index + 1;
      while (
        end < fragments.length &&
        fragments[end].whole &&
        (fragments[end].turn === turns[turns.length - 1] || fragments[end].turn === turns[turns.length - 1] + 1)
      ) {
        if (fragments[end].turn !== turns[turns.length - 1]) turns.push(fragments[end].turn);
        end += 1;
      }
      const run = fragments.slice(index, end);
      const byTurn = new Map();
      for (const entry of run) {
        if (!byTurn.has(entry.turn)) byTurn.set(entry.turn, new Set());
        byTurn.get(entry.turn).add(entry.messageId);
      }
      const complete = turns.every((turn) => {
        const all = allByTurn.get(turn) ?? new Set();
        const inRun = byTurn.get(turn);
        return all.size > 0 && all.size === inRun?.size && [...all].every((id) => inRun.has(id));
      });
      if (complete) {
        segments.push({ kind: "turns", from: turns[0], to: turns[turns.length - 1] });
        index = end;
        continue;
      }
    }
    segments.push({ kind: "message", messageId: fragment.messageId, from: fragment.from, to: fragment.to });
    index += 1;
  }
  return segments;
}

/** Merge overlapping or touching turn windows so no message is returned twice. */
function mergeWindows(windows) {
  const merged = [];
  for (const window of windows) {
    const last = merged[merged.length - 1];
    if (last && window.from <= last.to + 1) last.to = Math.max(last.to, window.to);
    else merged.push({ ...window });
  }
  return merged;
}

/** Search whole-string lowercase text, returning an original UTF-16 offset. */
function literalMatchOffset(text, needle) {
  const lowercase = text.toLowerCase();
  const offset = lowercase.indexOf(needle);
  if (offset < 0 || lowercase.length === text.length) return offset;

  // Lowercasing can expand a code point (İ becomes i + combining dot). Map the
  // position back before slicing; retain offsets within unchanged surrogate pairs.
  let originalOffset = 0;
  let lowercaseOffset = 0;
  for (const character of text) {
    const length = character.toLowerCase().length;
    if (offset < lowercaseOffset + length) {
      return originalOffset + Math.min(offset - lowercaseOffset, character.length - 1);
    }
    originalOffset += character.length;
    lowercaseOffset += length;
  }
  return -1;
}

/**
 * A requested message window must address real characters. An empty or backwards
 * window used to render as an empty body with `partial: {from, to}` and no hint,
 * which reads as a completed read; reject it instead.
 */
function checkWindow(message, start, until, label) {
  const length = message.text.length;
  const end = Math.min(until, length);
  if (start > until) throw new Error(`${label}: the window ends at ${until} before it starts at ${start}`);
  if (start > length) {
    throw new Error(`${label}: offset ${start} is past the end of message ${message.id} (${length} character(s))`);
  }
  if (start >= end) {
    throw new Error(`${label}: the window ${start}-${end} of message ${message.id} is empty (${length} character(s))`);
  }
}

function selectMessages(messages, scope, turnCount) {
  const messageWindow = {
    start: scope.kind === "message" ? (scope.offset ?? 0) : 0,
    until:
      scope.kind === "message" ? (scope.before ?? scope.until ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY,
  };
  const unitsOf = (indices, start = 0, until = Number.POSITIVE_INFINITY) =>
    indices.map((index) => ({ index, start, until }));

  if (scope.kind === "unread") {
    const units = [];
    const pendingSearch = [];
    for (const segment of scope.segments) {
      if (segment.kind === "search") {
        if (turnCount && segment.from > turnCount) {
          throw new Error(`the conversation has ${turnCount} turn(s); turn ${segment.from} does not exist`);
        }
        if (pendingSearch.length) {
          throw new Error("--unread carries at most one pending search segment");
        }
        pendingSearch.push(segment);
        continue;
      }
      if (segment.kind === "turns") {
        if (turnCount && segment.from > turnCount) {
          throw new Error(`the conversation has ${turnCount} turn(s); turn ${segment.from} does not exist`);
        }
        const to = Math.min(segment.to === Number.POSITIVE_INFINITY ? turnCount : segment.to, turnCount);
        for (const [index, message] of messages.entries()) {
          if (message.turn < segment.from || message.turn > to) continue;
          units.push({ index, start: 0, until: Number.POSITIVE_INFINITY });
        }
      } else {
        const index = messages.findIndex((message) => message.id === segment.messageId);
        if (index < 0) {
          throw new Error(`message ${segment.messageId} is not on the active branch of this conversation`);
        }
        checkWindow(messages[index], segment.from, segment.to, `--unread ${formatUnreadSegment(segment)}`);
        // The same message can legitimately carry two windows (a prefix and a suffix).
        units.push({ index, start: segment.from, until: segment.to });
      }
    }
    const indices = [...new Set(units.map((unit) => unit.index))];
    return {
      units,
      indices,
      pendingSearch,
      reserveOpening: true,
      direction: "oldest",
      turns: units.length
        ? { from: messages[units[0].index].turn, to: messages[units[units.length - 1].index].turn }
        : null,
    };
  }
  if (scope.kind === "find") {
    if (turnCount && scope.from > turnCount) {
      throw new Error(`the conversation has ${turnCount} turn(s); turn ${scope.from} does not exist`);
    }
    const needle = scope.term.toLowerCase();
    const matchedTurns = new Set();
    const matched = new Set();
    const matchOffsets = new Map();
    for (const [index, message] of messages.entries()) {
      if (message.turn < scope.from || message.turn > scope.to) continue;
      const offset = literalMatchOffset(message.text, needle);
      if (offset >= 0) {
        matched.add(index);
        matchOffsets.set(index, offset);
        matchedTurns.add(message.turn);
      }
    }
    const hits = [...matchedTurns].sort((left, right) => left - right);
    const windows = mergeWindows(
      hits.map((turn) => ({
        // Context never leaves the searched range, so the header's `in turns A-B`
        // describes exactly what can come back.
        from: Math.max(scope.from, 1, turn - scope.contextTurns),
        to: Math.min(scope.to, turnCount, turn + scope.contextTurns),
      })),
    );
    const indices = messages
      .map((_, index) => index)
      .filter((index) => windows.some((window) => messages[index].turn >= window.from && messages[index].turn <= window.to));
    // A hit is the reason for the read, so matched messages outrank the context
    // around them: an unrelated long answer must not push the hit out of the budget.
    const newestFirst = (list) => [...list].sort((left, right) => right - left);
    return {
      units: unitsOf(indices),
      indices,
      priority: [...newestFirst([...matched]), ...newestFirst(indices.filter((index) => !matched.has(index)))],
      matched,
      matchOffsets,
      reserveOpening: false,
      direction: "newest",
      // No implicit search outside the requested range, including zero-hit reads.
      pendingSearch: [],
      turns: windows.length ? { from: windows[0].from, to: windows[windows.length - 1].to } : null,
      matches: {
        term: scope.term,
        messages: matched.size,
        turns: hits,
        windows,
        searchedTurns: { from: scope.from, to: Math.min(scope.to, turnCount) },
        contextTurns: scope.contextTurns,
      },
    };
  }
  if (scope.kind === "message") {
    const index = messages.findIndex((message) => message.id === scope.id);
    if (index < 0) {
      throw new Error(
        `message ${scope.id} is not on the active branch of this conversation; ` +
          "ids come from a --json read or a next: hint",
      );
    }
    checkWindow(messages[index], messageWindow.start, messageWindow.until, `--message ${scope.id}`);
    return {
      units: unitsOf([index], messageWindow.start, messageWindow.until),
      indices: [index],
      reserveOpening: false,
      // `--before N` reads backwards from N; everything else reads forwards.
      direction: scope.before === undefined ? "oldest" : "newest",
      turns: { from: messages[index].turn, to: messages[index].turn },
    };
  }
  if (scope.kind === "last-messages") {
    const indices = messages.map((_, index) => index).slice(Math.max(0, messages.length - scope.count));
    return {
      units: unitsOf(indices),
      indices,
      reserveOpening: false,
      direction: "newest",
      turns: null,
    };
  }
  if (!turnCount) return { units: [], indices: [], reserveOpening: true, direction: "newest", turns: null };
  const from = scope.kind === "last-turns" ? Math.max(1, turnCount - scope.count + 1) : scope.from;
  if (from > turnCount) throw new Error(`the conversation has ${turnCount} turn(s); turn ${from} does not exist`);
  const to = Math.min(scope.to ?? turnCount, turnCount);
  const indices = messages
    .map((_, index) => index)
    .filter((index) => messages[index].turn >= from && messages[index].turn <= to);
  return {
    units: unitsOf(indices),
    indices,
    reserveOpening: true,
    direction: scope.kind === "turns" ? "oldest" : "newest",
    turns: { from, to },
  };
}

/** Budget order: an explicit index list wins, else document order by direction. */
function priorityOrder(selection) {
  if (selection.priority) {
    const byIndex = new Map();
    for (const unit of selection.units) if (!byIndex.has(unit.index)) byIndex.set(unit.index, unit);
    return selection.priority.map((index) => byIndex.get(index)).filter(Boolean);
  }
  return selection.direction === "newest" ? [...selection.units].reverse() : [...selection.units];
}

/** Keep the end of a message for newest-first reads, the start for forward reads. */
function sliceText(text, maxChars, direction, start = 0, until = text.length) {
  const end = Math.min(until, text.length);
  const window = text.slice(start, end);
  if (maxChars >= window.length) return { text: window, from: start, to: end };
  if (direction === "newest") {
    const from = Math.max(start, end - maxChars);
    return { text: text.slice(from, end), from, to: end };
  }
  return { text: window.slice(0, maxChars), from: start, to: start + maxChars };
}

/** Per-window status: complete (every selected message kept whole), partial, or missing. */
function describeWindows(selection, kept, messages) {
  const windows = selection.matches.windows.map((window) => {
    const inside = (turn) => turn >= window.from && turn <= window.to;
    const selected = selection.indices.filter((index) => inside(messages[index].turn)).length;
    const returned = kept.filter((message) => inside(message.turn));
    const complete =
      selected > 0 && returned.length === selected && returned.every((message) => !message.partial);
    return { ...window, status: !returned.length ? "missing" : complete ? "complete" : "partial" };
  });
  return {
    ...selection.matches,
    windows,
    windowsReturned: windows.filter((window) => window.status !== "missing").length,
    windowsComplete: windows.filter((window) => window.status === "complete").length,
  };
}

function buildPlan({ id, title, messages, scope, selection, keep, maxChars, turnCount, branch, toolMessages, includeTools, imageDir, imageMessages = [], authSource = null, json = false }) {
  const keptWindowByKey = new Map();
  const kept = keep
    .slice()
    .sort((left, right) => left.index - right.index)
    .map((entry) => {
      const message = messages[entry.index];
      const start = entry.start ?? 0;
      const until = entry.until ?? Number.POSITIVE_INFINITY;
      const windowLength = Math.max(0, Math.min(until, message.text.length) - start);
      const limit = entry.sliceChars ?? windowLength;
      // A trimmed hit still has to show the hit: move the window around it.
      const hit = selection.matchOffsets?.get(entry.index);
      let sliceStart = start;
      let direction = entry.direction ?? selection.direction;
      const windowEnd = Math.min(until, message.text.length);
      const keptFrom = direction === "newest" ? Math.max(start, windowEnd - limit) : start;
      const keptTo = direction === "newest" ? windowEnd : Math.min(start + limit, windowEnd);
      if (hit != null && entry.sliceChars != null && (hit < keptFrom || hit >= keptTo)) {
        sliceStart = Math.max(start, hit - Math.floor(limit / 4));
        direction = "oldest";
      }
      const sliced = sliceText(message.text, limit, direction, sliceStart, until);
      keptWindowByKey.set(`${entry.index}:${start}:${windowEnd}`, { from: sliced.from, to: sliced.to });
      const visibleImages = message.imageRanges?.filter((range) => range.from < sliced.to && range.to > sliced.from);
      const visibleIds = visibleImages && new Set(visibleImages.map((range) => range.fileId));
      const item = {
        id: message.id,
        role: message.role,
        turn: message.turn,
        contentType: message.contentType,
        text: sliced.text,
        images: visibleImages ? visibleImages.length : message.images,
        attachments: message.attachments,
        imageParts: visibleIds ? (message.imageParts ?? []).filter((part) => visibleIds.has(part.fileId)) : message.imageParts,
        match: selection.matched?.has(entry.index) === true,
        matchOffset: hit ?? null,
        partial: null,
      };
      if (sliced.from > 0 || sliced.to < message.text.length) {
        item.partial = { from: sliced.from, to: sliced.to, totalChars: message.text.length };
      }
      // Only claim a match when the returned text really carries the term.
      if (item.match && selection.matches?.term) {
        if (!item.text.toLowerCase().includes(selection.matches.term.toLowerCase())) item.match = false;
      }
      return item;
    });

  // One entry per unique file, in the order the kept messages show them. The path
  // is derived from the file id, so the budget search and the later download agree.
  // Tool messages the transcript omits still contribute: ChatGPT's generated images
  // arrive in exactly those messages.
  const images = [];
  if (imageDir) {
    const keptIds = new Set(kept.map((message) => message.id));
    const toolTurns = new Set(kept.filter((message) => {
      if (scope.kind === "message") return false;
      if (scope.kind !== "unread") return true;
      return scope.segments.some((segment) => segment.kind === "turns" && message.turn >= segment.from && message.turn <= segment.to);
    }).map((message) => message.turn));
    const sources = [
      ...kept.map((message) => ({ message, omittedTool: false })),
      ...imageMessages
        .filter((message) => !includeTools && message.role === "tool" && !keptIds.has(message.id) && toolTurns.has(message.turn))
        .map((message) => ({ message, omittedTool: true })),
    ];
    const seen = new Set();
    for (const { message, omittedTool } of sources) {
      for (const part of message.imageParts ?? []) {
        if (seen.has(part.fileId)) continue;
        seen.add(part.fileId);
        images.push({
          fileId: part.fileId,
          messageId: message.id,
          turn: message.turn,
          omittedTool,
          mime: part.mime,
          width: part.width,
          height: part.height,
          sizeBytes: part.sizeBytes,
          path: join(imageDir, imageFileName(part)),
        });
      }
    }
  }

  const plan = {
    id,
    title,
    maxChars,
    scope,
    branch,
    format: FORMAT_VERSION,
    authSource,
    json: Boolean(json),
    direction: selection.direction,
    includeTools: includeTools === true,
    imageDir: imageDir ?? null,
    images,
    unread: [...unreadAfter(messages, selection, keptWindowByKey), ...(selection.pendingSearch ?? [])],
    turns: {
      total: turnCount,
      from: selection.turns?.from ?? null,
      to: selection.turns?.to ?? null,
      returned: [...new Set(kept.map((message) => message.turn))],
    },
    counts: {
      messagesTotal: messages.length,
      messagesSelected: selection.indices.length,
      messagesReturned: new Set(kept.map((message) => message.id)).size,
    },
    content: {
      ...kept.reduce(
        (acc, message) => ({ images: acc.images + message.images, attachments: acc.attachments + message.attachments }),
        { images: 0, attachments: 0 },
      ),
      toolMessages: toolMessages ?? 0,
    },
    matches: selection.matches ? describeWindows(selection, kept, messages) : null,
    truncated: kept.length < selection.indices.length || kept.some((message) => message.partial),
    messages: kept,
    next: null,
  };
  plan.next = nextCommand(plan);
  return plan;
}

function viewOptions(plan) {
  return `${plan.maxChars === DEFAULT_MAX_CHARS ? "" : ` --max-chars ${plan.maxChars}`}` +
    `${plan.includeTools ? " --include-tools" : ""}` +
    `${plan.imageDir ? ` --images ${shellQuote(plan.imageDir)}` : ""}` +
    `${plan.authSource ? ` --auth-source ${plan.authSource}` : ""}` +
    `${plan.json ? " --json" : ""}`;
}

function nextCommand(plan) {
  if (!plan.unread.length) return null;
  const suffix = viewOptions(plan);
  const reads = plan.unread.filter((segment) => segment.kind !== "search");
  if (!reads.length) {
    const search = plan.unread[0];
    const range = search.to === Number.POSITIVE_INFINITY ? `${search.from}:` : `${search.from}:${search.to}`;
    const options = `--turns ${range} --context-turns ${search.contextTurns}${suffix}`;
    return search.term.startsWith("-")
      ? `${SCRIPT_COMMAND} chat find ${hintId(plan.id)} ${options} -- ${shellQuote(search.term)}`
      : `${SCRIPT_COMMAND} chat find ${hintId(plan.id)} ${shellQuote(search.term)} ${options}`;
  }
  const segments = plan.unread.map((segment) => `--unread ${segmentSpec(segment)}`).join(" ");
  return `${SCRIPT_COMMAND} chat read ${hintId(plan.id)} ${segments}${suffix}`;
}

/** Prefer the selected user question, falling back to the turn's first selected message. */
function openingMessage(messages, selection, keep, boundaryIndex) {
  const turn = messages[boundaryIndex].turn;
  const opening =
    selection.indices.find((index) => messages[index].turn === turn && messages[index].role === "user") ??
    selection.indices.find((index) => messages[index].turn === turn);
  if (opening == null || opening === boundaryIndex) return null;
  return keep.some((entry) => entry.index === opening) ? null : opening;
}

/**
 * Resolve one read into a plan plus its rendered document.
 *
 * Messages are kept whole, highest priority first, and the message that hits the
 * budget boundary contributes as much of itself as fits. A newest-first read
 * keeps the end of that message, a forward read keeps its start, so a truncated
 * read never looks like a complete one.
 */
export function planRead({ id, title, messages, scope, maxChars, render, branch = "current_node", toolMessages = 0, includeTools = false, imageDir = null, imageMessages = [], authSource = null, json = render === renderReadJson }) {
  if (authSource !== null && !["env", "pi", "codex"].includes(authSource)) throw new Error("invalid resolved auth source");
  const turnCount = messages.length ? messages[messages.length - 1].turn : 0;
  const selection = selectMessages(messages, scope, turnCount);
  const build = (keep) =>
    buildPlan({ id, title, messages, scope, selection, keep, maxChars, turnCount, branch, toolMessages, includeTools, imageDir, imageMessages, authSource, json });
  const fits = (keep) => outputFits(render(build(keep)), maxChars);
  const order = priorityOrder(selection);
  const entries = (units) => units.map((unit) => ({ ...unit }));
  const windowLength = (unit) => Math.max(0, Math.min(unit.until, messages[unit.index].text.length) - unit.start);
  const useful = (plan) => plan.messages.some((message) => message.text.length > 0) &&
    (!selection.matched?.size || plan.messages.some((message) => message.match));

  // Continuation metadata is not monotone: completing a turn can remove many
  // unread segments. Always try the complete selection before any budget floor.
  const complete = build(entries(order));
  const completeDocument = render(complete);
  if (outputFits(completeDocument, maxChars)) return { plan: complete, document: completeDocument };

  // Raw body costs are monotone lower bounds, unlike the complete rendered
  // envelope. Beyond this prefix no whole-message candidate can fit.
  let upper = 0;
  let chars = 0;
  let bytes = 0;
  let lines = 0;
  for (const unit of order) {
    const message = messages[unit.index];
    const text = message.text.slice(unit.start, unit.until);
    // Include only mandatory per-message framing. JSON escapes body newlines,
    // whereas text renders them; neither lower bound includes unread metadata.
    const framing = json
      ? JSON.stringify({ id: message.id, role: message.role, turn: message.turn, contentType: message.contentType, text: "" }, null, 2)
      : `\n[${message.role}]\n\n`;
    chars += text.length + framing.length;
    bytes += Buffer.byteLength(text, "utf8") + Buffer.byteLength(framing, "utf8");
    lines += framing.split("\n").length - 1 + (json ? 0 : text.split("\n").length - 1);
    if (chars > maxChars || bytes > MAX_OUTPUT_BYTES || lines >= MAX_OUTPUT_LINES) break;
    upper += 1;
  }
  let keep = [];
  let count = 0;
  for (let size = upper; size > 0; size--) {
    const candidate = entries(order.slice(0, size));
    const plan = build(candidate);
    if (outputFits(render(plan), maxChars) && useful(plan)) {
      keep = candidate;
      count = size;
      break;
    }
  }

  if (count < order.length) {
    const boundary = { ...order[count] };
    const opening = selection.reserveOpening ? openingMessage(messages, selection, keep, boundary.index) : null;
    const unit = opening == null ? null : selection.units.find((entry) => entry.index === opening);
    const reserved = unit == null ? null : { ...unit, sliceChars: Math.min(messages[opening].text.length, BOUNDARY_QUESTION_CHARS), direction: "oldest" };
    // A partial hit must contain its full term; zero-sized or nonmatching slices
    // must never be accepted as successful progress.
    const minimum = Math.min(windowLength(boundary), selection.matched?.has(boundary.index)
      ? Math.max(1, Math.ceil(selection.matches.term.length * 4 / 3)) : MIN_BODY_CHARS);
    for (const prefix of reserved ? [[...keep, reserved], keep] : [keep]) {
      const candidate = (length) => [...prefix, { ...boundary, sliceChars: length }];
      if (!minimum || !fits(candidate(minimum)) || !useful(build(candidate(minimum)))) {
        // If the budget fits the question but not a useful answer slice, returning
        // that question is real progress and preserves opening context.
        if (prefix.length > keep.length && fits(prefix) && useful(build(prefix))) {
          keep = prefix;
          break;
        }
        continue;
      }
      let lo = minimum;
      let hi = windowLength(boundary);
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (fits(candidate(mid)) && useful(build(candidate(mid)))) lo = mid;
        else hi = mid - 1;
      }
      keep = candidate(lo);
      break;
    }
  }

  const plan = build(keep);
  const document = render(plan);
  if (order.length && !useful(plan)) {
    throw new Error(`--max-chars ${maxChars} is too small to return useful transcript within the output guards; increase the budget or select a narrower range`);
  }
  if (!outputFits(document, maxChars)) {
    throw new Error(`this read cannot fit the output guards (${maxChars} characters / ${MAX_OUTPUT_BYTES} bytes / ${MAX_OUTPUT_LINES} lines)`);
  }
  return { plan, document };
}

function scopeLabel(plan) {
  if (plan.scope.kind === "find") {
    const { searchedTurns, contextTurns } = plan.matches;
    const where =
      searchedTurns.to >= searchedTurns.from ? `in turns ${searchedTurns.from}-${searchedTurns.to}` : "in an empty conversation";
    return `find ${JSON.stringify(plan.scope.term)} ${where} (context ±${contextTurns} turn(s))`;
  }
  if (plan.scope.kind === "message") {
    if (plan.scope.before !== undefined) return `message ${plan.scope.id} up to offset ${plan.scope.before}`;
    const until = plan.scope.until == null ? "" : ` to ${plan.scope.until}`;
    return `message ${plan.scope.id} from offset ${plan.scope.offset}${until}`;
  }
  if (plan.scope.kind === "unread") {
    return `unread ${plan.scope.segments.map((segment) => formatUnreadSegment(segment)).join(", ")}`;
  }
  if (plan.scope.kind === "last-messages") {
    return `latest ${plan.counts.messagesSelected} of ${plan.counts.messagesTotal} messages`;
  }
  const returned = plan.turns.returned;
  const range = returned.length ? `${returned[0]}-${returned[returned.length - 1]}` : "none";
  if (plan.scope.kind === "turns") return `turns ${plan.turns.from}-${plan.turns.to} of ${plan.turns.total}`;
  return `latest ${returned.length} of ${plan.turns.total} turns (turns ${range})`;
}

function describeContent(content) {
  const parts = [];
  if (content.images) parts.push(`${content.images} image(s)`);
  if (content.attachments) parts.push(`${content.attachments} attachment(s)`);
  if (content.toolMessages) parts.push(`${content.toolMessages} tool message(s)`);
  return parts.join(", ");
}

/** Humanised byte count for the image block. */
function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function summarizeWindows(windows) {
  const count = (status) => windows.filter((window) => window.status === status).length;
  const parts = [];
  if (count("complete")) parts.push(`${count("complete")} complete`);
  if (count("partial")) parts.push(`${count("partial")} partial`);
  if (count("missing")) parts.push(`${count("missing")} not returned`);
  return `${windows.length} window(s): ${parts.join(", ") || "none"}`;
}

/** Text output: metadata first, then the transcript, one [turn N] marker per turn. */
export function renderReadText(plan, { reserveImageFailures = false } = {}) {
  const lines = [
    `# ${oneLine(plan.title)}`,
    `# id: ${oneLine(plan.id)}`,
    `# read: ${oneLine(scopeLabel(plan))}`,
    `# branch: ${oneLine(plan.branch)} · format ${plan.format}`,
  ];
  lines.push(`# complete: ${plan.unread.length === 0} (selected scope only)`);
  if (plan.authSource) lines.push(`# credential source: ${plan.authSource}`);
  if (plan.matches) {
    const listed = plan.matches.turns.slice(0, 10).join(", ");
    const more = plan.matches.turns.length > 10 ? ", …" : "";
    const breakdown = plan.matches.windows.length ? ` — ${summarizeWindows(plan.matches.windows)}` : "";
    lines.push(
      `# matches: ${plan.matches.messages} message(s) in turn(s) ${plan.matches.turns.length ? listed + more : "none"}${breakdown}`,
    );
  }
  if (plan.unread.length) {
    lines.push(`# unread: ${oneLine(plan.unread.map((segment) => formatUnreadSegment(segment)).join(", "))}`);
  }
  if (plan.truncated) {
    const partial = plan.messages.filter((message) => message.partial).length;
    lines.push(
      `# truncated: kept ${plan.counts.messagesReturned} of ${plan.counts.messagesSelected} selected message(s)` +
        (partial ? `, ${partial} partial` : ""),
    );
  }
  const content = describeContent(plan.content);
  if (content) lines.push(`# content omitted: ${content}`);
  if (plan.images.length) {
    const failed = reserveImageFailures ? plan.images.length : plan.images.filter((image) => image.failed).length;
    lines.push(
      `# images: ${plan.images.length} unique file(s)${failed ? `, ${failed} not saved` : ""} under ${oneLine(plan.imageDir)}`,
    );
    for (const image of plan.images) {
      const source = image.omittedTool ? " (tool)" : "";
      const failedLine = `#   ${oneLine(image.path)}  NOT SAVED${source}`;
      if (image.failed) {
        lines.push(failedLine);
        continue;
      }
      const width = imageDimension(image.width);
      const height = imageDimension(image.height);
      const dimensions = width && height ? `  ${width}x${height}` : "";
      const size = formatBytes(image.sizeBytes);
      const savedLine = `#   ${oneLine(image.path)}${dimensions}${size ? `  ${size}` : ""}  turn ${image.turn}${source}`;
      // Mixed results can exceed both the all-success and all-failure renderings.
      // Budget each line independently, without changing the actual download state.
      lines.push(reserveImageFailures && failedLine.length > savedLine.length ? failedLine : savedLine);
    }
  }
  if (plan.next) {
    if (oneLine(plan.next) === plan.next) lines.push(`# next: ${plan.next}`);
    else lines.push("# continuation: available; use --json to preserve exact control characters in arguments");
  }

  let out = `${lines.join("\n")}\n`;
  if (plan.matches && plan.matches.messages === 0) {
    const { searchedTurns } = plan.matches;
    const where =
      searchedTurns.to >= searchedTurns.from ? `in turns ${searchedTurns.from}-${searchedTurns.to}` : "in this conversation";
    out += `\n(no literal match for ${JSON.stringify(plan.matches.term)} ${where})\n`;
  }
  let lastTurn = null;
  for (const message of plan.messages) {
    if (message.turn !== lastTurn) {
      out += `\n[turn ${message.turn}]\n`;
      lastTurn = message.turn;
    }
    out += `\n[${message.role}]${message.match ? " (match)" : ""}\n`;
    if (message.partial?.from > 0) {
      out += `…[${message.id}: chars 0-${message.partial.from} of ${message.partial.totalChars} omitted]…\n`;
    }
    out += `${message.text}\n`;
    if (message.partial && message.partial.to < message.partial.totalChars) {
      out += `…[${message.id}: continues at offset ${message.partial.to} of ${message.partial.totalChars}]…\n`;
    }
  }
  return out;
}

/** JSON output: the same plan, with counts and continuation in one envelope. */
export function renderReadJson(plan, { reserveImageFailures = false } = {}) {
  return `${JSON.stringify(
    {
      id: plan.id,
      title: plan.title,
      branch: plan.branch,
      format: plan.format,
      credentialSource: plan.authSource,
      complete: plan.unread.length === 0,
      scope: {
        kind: plan.scope.kind,
        turns: { total: plan.turns.total, from: plan.turns.from, to: plan.turns.to, returned: plan.turns.returned },
        messages: plan.counts,
        messageId: plan.scope.id ?? null,
        offset: plan.scope.kind === "message" ? plan.scope.offset : null,
        until: plan.scope.kind === "message" ? (plan.scope.until ?? null) : null,
        before: plan.scope.kind === "message" ? (plan.scope.before ?? null) : null,
      },
      truncated: plan.truncated,
      content: plan.content,
      ...(plan.imageDir
        ? {
            imageDir: plan.imageDir,
            images: reserveImageFailures ? plan.images.map((image) => ({ ...image, failed: true })) : plan.images,
          }
        : {}),
      unread: plan.unread,
      ...(plan.matches ? { matches: plan.matches } : {}),
      budget: { maxChars: plan.maxChars, maxBytes: MAX_OUTPUT_BYTES, maxLines: MAX_OUTPUT_LINES },
      next: plan.next,
      messages: plan.messages.map((message) => ({
        id: message.id,
        role: message.role,
        turn: message.turn,
        contentType: message.contentType,
        text: message.text,
        ...(message.match ? { match: true } : {}),
        ...(message.matchOffset != null ? { matchOffset: message.matchOffset } : {}),
        ...(message.partial ? { partial: message.partial } : {}),
        ...(message.images || message.attachments
          ? { omitted: { images: message.images, attachments: message.attachments } }
          : {}),
      })),
    },
    null,
    2,
  )}\n`;
}

/** Humanised character count for outline lines. */
function formatChars(value) {
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}k`;
}

const ROLE_INITIALS = { user: "u", assistant: "a", tool: "t", system: "s" };
/** Preview lengths tried in order; the first one that fits the budget wins. */
const OUTLINE_PREVIEWS = [120, 80, 48, 28, 16];

/** One entry per turn of the active branch, with the total characters it holds. */
function outlineEntries(messages) {
  const byTurn = new Map();
  for (const message of messages) {
    if (!byTurn.has(message.turn)) byTurn.set(message.turn, { turn: message.turn, chars: 0, messages: [] });
    const entry = byTurn.get(message.turn);
    entry.messages.push(message);
    entry.chars += message.text.length;
  }
  return [...byTurn.values()].sort((left, right) => left.turn - right.turn);
}

function outlinePreview(text, preview) {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > preview ? `${collapsed.slice(0, preview)}…` : collapsed;
}

function buildOutlinePlan({ id, title, entries, selected, turnCount, maxChars, preview, branch, toolMessages, includeTools, authSource, json }) {
  const listed = entries.flatMap((entry) => entry.messages);
  const plan = {
    id,
    title,
    maxChars,
    preview,
    branch,
    format: FORMAT_VERSION,
    authSource,
    json: Boolean(json),
    includeTools: includeTools === true,
    scope: { kind: "outline" },
    turns: {
      total: turnCount,
      from: selected.length ? selected[0].turn : null,
      to: selected.length ? selected[selected.length - 1].turn : null,
      returned: entries.map((entry) => entry.turn),
    },
    counts: {
      turnsSelected: selected.length,
      turnsReturned: entries.length,
      messagesSelected: selected.reduce((sum, entry) => sum + entry.messages.length, 0),
      messagesReturned: listed.length,
    },
    content: {
      ...listed.reduce(
        (acc, message) => ({ images: acc.images + message.images, attachments: acc.attachments + message.attachments }),
        { images: 0, attachments: 0 },
      ),
      toolMessages: toolMessages ?? 0,
    },
    truncated: entries.length < selected.length,
    entries: entries.map((entry) => ({
      turn: entry.turn,
      chars: entry.chars,
      messages: entry.messages.map((message) => ({
        id: message.id,
        role: message.role,
        chars: message.text.length,
        preview: outlinePreview(message.text, preview),
      })),
    })),
    next: null,
  };
  plan.next = outlineNext(plan);
  return plan;
}

function outlineNext(plan) {
  const from = plan.turns.from ?? 1;
  const oldest = plan.turns.returned[0];
  if (oldest == null || oldest <= from) return null;
  return `${SCRIPT_COMMAND} chat outline ${hintId(plan.id)} --turns ${from}:${oldest - 1}${viewOptions(plan)}`;
}

/**
 * Build a compact index of the conversation: one line per turn with its size and a
 * short preview. The preview shortens until the outline fits the budget; if even the
 * shortest preview is too long, the newest turns are kept and the rest is left to a
 * `next:` command.
 */
export function planOutline({
  id,
  title,
  messages,
  scope,
  maxChars,
  render,
  branch = "current_node",
  toolMessages = 0,
  includeTools = false,
  authSource = null,
  json = render === renderOutlineJson,
}) {
  if (authSource !== null && !["env", "pi", "codex"].includes(authSource)) throw new Error("invalid resolved auth source");
  const turnCount = messages.length ? messages[messages.length - 1].turn : 0;
  const from = scope.from ?? 1;
  if (turnCount && from > turnCount) {
    throw new Error(`the conversation has ${turnCount} turn(s); turn ${from} does not exist`);
  }
  const to = Math.min(scope.to ?? turnCount, turnCount);
  const selected = outlineEntries(messages).filter((entry) => entry.turn >= from && entry.turn <= to);

  const attempt = (entries, preview) => {
    const plan = buildOutlinePlan({
      id,
      title,
      entries,
      selected,
      turnCount,
      maxChars,
      preview,
      branch,
      toolMessages,
      includeTools,
      authSource,
      json,
    });
    const document = render(plan);
    return { plan, document, fits: outputFits(document, maxChars) };
  };

  const smallest = OUTLINE_PREVIEWS[OUTLINE_PREVIEWS.length - 1];

  for (const preview of OUTLINE_PREVIEWS) {
    const candidate = attempt(selected, preview);
    if (candidate.fits) return candidate;
  }

  // Nothing fits whole: keep the newest turns that still fit at the shortest preview.
  // The smallest useful outline is its metadata plus one turn; below that the read
  // fails instead of silently returning an empty page.
  const newest = selected.length ? [selected[selected.length - 1]] : [];
  const floor = attempt(newest, smallest);
  if (!floor.fits) {
    throw new Error(
      `--max-chars ${maxChars} is too small for an outline; use at least ${floor.document.length + 1} characters`,
    );
  }
  let low = 0;
  let high = selected.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (attempt(selected.slice(selected.length - mid), smallest).fits) low = mid;
    else high = mid - 1;
  }
  const kept = low ? selected.slice(selected.length - low) : newest;
  const plan = buildOutlinePlan({
    id,
    title,
    entries: kept,
    selected,
    turnCount,
    maxChars,
    preview: smallest,
    branch,
    toolMessages,
    includeTools,
    authSource,
    json,
  });
  const document = render(plan);
  if (!outputFits(document, maxChars)) {
    throw new Error(`internal error: the outline exceeded its output limits (${document.length} characters)`);
  }
  return { plan, document };
}

function outlineLabel(plan) {
  const { from, to, total } = plan.turns;
  const range = !total
    ? "an empty conversation"
    : from === 1 && to === total
      ? `all ${total} turn(s)`
      : `turns ${from}-${to} of ${total}`;
  return `outline of ${range} (preview ${plan.preview} chars)`;
}

function outlineTextLine(entry) {
  const parts = entry.messages.map((message) => `${ROLE_INITIALS[message.role] ?? "?"}:${message.preview}`);
  return `t${entry.turn}  ${formatChars(entry.chars)}  ${parts.join(" | ")}`;
}

/** Text outline: metadata, then one compact [t<N>  size  u:… | a:…] line per turn. */
export function renderOutlineText(plan) {
  const lines = [
    `# ${oneLine(plan.title)}`,
    `# id: ${oneLine(plan.id)}`,
    `# read: ${oneLine(outlineLabel(plan))}`,
    `# branch: ${oneLine(plan.branch)} · format ${plan.format}`,
  ];
  lines.push(`# complete: ${!plan.truncated} (selected outline only)`);
  if (plan.authSource) lines.push(`# credential source: ${plan.authSource}`);
  if (plan.truncated) {
    lines.push(
      `# truncated: ${plan.counts.turnsReturned} of ${plan.counts.turnsSelected} turn(s) listed, ` +
        `${plan.counts.messagesReturned} of ${plan.counts.messagesSelected} message(s)`,
    );
  }
  const content = describeContent(plan.content);
  if (content) lines.push(`# content omitted: ${content}`);
  if (plan.next) {
    if (oneLine(plan.next) === plan.next) lines.push(`# next: ${plan.next}`);
    else lines.push("# continuation: available; use --json to preserve exact control characters in arguments");
  }
  const body = plan.entries.map((entry) => outlineTextLine(entry));
  return `${lines.join("\n")}\n\n${body.length ? `${body.join("\n")}\n` : "(no turns)\n"}`;
}

/** JSON outline: the same plan, one object per turn instead of full message text. */
export function renderOutlineJson(plan) {
  return `${JSON.stringify(
    {
      id: plan.id,
      title: plan.title,
      branch: plan.branch,
      format: plan.format,
      credentialSource: plan.authSource,
      complete: !plan.truncated,
      scope: {
        kind: "outline",
        turns: { total: plan.turns.total, from: plan.turns.from, to: plan.turns.to, returned: plan.turns.returned },
        messages: plan.counts,
      },
      preview: plan.preview,
      truncated: plan.truncated,
      content: plan.content,
      budget: { maxChars: plan.maxChars, maxBytes: MAX_OUTPUT_BYTES, maxLines: MAX_OUTPUT_LINES },
      next: plan.next,
      turns: plan.entries,
    },
    null,
    2,
  )}\n`;
}

/** Replace every occurrence of a known secret so it cannot surface in output. */
export function redact(text, secrets) {
  let out = String(text ?? "");
  for (const secret of secrets ?? []) {
    if (typeof secret === "string" && secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  return out;
}

/**
 * Pi's own config variables are PI_CODING_AGENT_DIR (current) and PI_AGENT_DIR
 * (older spelling this CLI accepted); both are honoured.
 */
export function piAgentDir(env = process.env) {
  return env.PI_CODING_AGENT_DIR || env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function codexDir(env = process.env) {
  return env.CODEX_HOME || join(homedir(), ".codex");
}

/**
 * Build the curl invocation for one request. The access token and account id go
 * into a config file on stdin (`-K -`) so they never appear in the process
 * argument list, where any local process could read them. `configUrl` also moves
 * the URL into that config — used for signed download URLs, which are credentials
 * of their own — and `timeoutSeconds` gives the slower file downloads more time.
 *
 * Throws on a value that cannot be carried safely, so no caller can hand curl a
 * header it would mis-parse or a value that injects another header.
 */
export function curlRequestSpec(auth, url, { configUrl = false, timeoutSeconds = 60 } = {}) {
  const token = headerSafe(auth.token, "access token");
  const accountId = auth.accountId ? headerSafe(auth.accountId, "account id") : undefined;
  const lines = [
    accountId ? `header = "chatgpt-account-id: ${accountId}"` : null,
    `header = "Authorization: Bearer ${token}"`,
    'header = "oai-language: zh-CN"',
    `header = "User-Agent: ${UA}"`,
    'header = "Referer: https://chatgpt.com/"',
    configUrl ? `url = "${headerSafe(url, "download URL")}"` : null,
  ].filter((line) => line !== null);
  return {
    args: [
      // Must be first: a default curl config can enable verbose/trace output or redirects.
      "-q",
      "-sS",
      "--proto",
      "=https",
      "--max-time",
      String(timeoutSeconds),
      "-w",
      "\n%{http_code}",
      "-K",
      "-",
      ...(configUrl ? [] : [url]),
    ],
    config: `${lines.join("\n")}\n`,
  };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    // A broken or unreadable configured store is not an absent source. Never
    // echo JSON parse errors: their snippets could contain credential values.
    fail(`cannot read credential store (${error.code ?? "invalid JSON"}); refusing to change credential sources`);
  }
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

/**
 * curl config values are double-quoted, and curl collapses backslashes inside
 * quotes. Rather than guess, reject anything outside printable ASCII or carrying
 * a quote/backslash — which also blocks CRLF header injection from an env var.
 */
function headerSafe(text, label) {
  const value = String(text);
  if (!value || !/^[\x20-\x7E]+$/.test(value) || value.includes('"') || value.includes("\\")) {
    throw new Error(`the ${label} is empty or contains characters that cannot be sent safely`);
  }
  return value;
}

/** User-facing credential check: report the problem instead of throwing. */
function credentialValue(value, label) {
  if (value == null) return undefined;
  try {
    return headerSafe(String(value).trim(), label);
  } catch (error) {
    fail(`${error.message}; refusing to use it.`);
  }
}

function refreshViaPi(agentDir) {
  const args = ["auth", "print-bearer-token", "--provider", "openai-codex"];
  const options = {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
  };
  try {
    // `shell: true` is deprecated (DEP0190) because it concatenates arguments;
    // cmd.exe is invoked explicitly on Windows so the npm shim still resolves.
    const out =
      process.platform === "win32"
        ? execFileSync("cmd.exe", ["/d", "/s", "/c", `pi ${args.join(" ")}`], options).trim()
        : execFileSync("pi", args, options).trim();
    return out.length > 100 ? out : null;
  } catch {
    return null;
  }
}

function loadAuth(requested = "auto") {
  if (!AUTH_SOURCES.has(requested)) fail("--auth-source must be auto, env, pi or codex");
  if (requested === "env" || (requested === "auto" && process.env.CHATGPT_ACCESS_TOKEN)) {
    if (!process.env.CHATGPT_ACCESS_TOKEN) fail("no credentials in selected env source; set CHATGPT_ACCESS_TOKEN");
    return {
      token: credentialValue(process.env.CHATGPT_ACCESS_TOKEN, "CHATGPT_ACCESS_TOKEN"),
      accountId: credentialValue(process.env.CHATGPT_ACCOUNT_ID, "CHATGPT_ACCOUNT_ID"),
      source: "env",
    };
  }

  if (requested === "auto" || requested === "pi") {
    const agentDir = resolve(piAgentDir());
    const piAuthPath = join(agentDir, "auth.json");
    const entry = readJson(piAuthPath)?.["openai-codex"];
    if (entry?.access) {
      const expires = Number(entry.expires ?? 0);
      if (expires && expires < Date.now() + 60_000) {
        const fresh = refreshViaPi(agentDir);
        if (!fresh) fail("the selected Pi token is expired and refresh failed; refusing to switch credential sources");
        const refreshed = readJson(piAuthPath)?.["openai-codex"];
        return {
          token: credentialValue(fresh, "refreshed Pi access token"),
          accountId: credentialValue(refreshed?.access === fresh ? refreshed.accountId : undefined, "Pi account id"),
          source: "pi",
          refreshed: true,
        };
      }
      return {
        token: credentialValue(entry.access, "Pi access token"),
        accountId: credentialValue(entry.accountId, "Pi account id"),
        source: "pi",
      };
    }
    if (requested === "pi") fail("no credentials in selected pi source; use the normal Pi OAuth login flow");
  }

  const tokens = readJson(join(codexDir(), "auth.json"))?.tokens;
  if (!tokens?.access_token) fail(`no ChatGPT credentials found in ${requested === "auto" ? "env, pi or codex" : "selected codex source"}`);
  return {
    token: credentialValue(tokens.access_token, "Codex access token"),
    accountId: credentialValue(tokens.account_id, "Codex account id"),
    source: "codex",
  };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * One authenticated GET. `soft` makes every failure throw instead of exiting, so a
 * caller that can carry on (an image download) gets a reason it can report.
 */
function apiGet(path, auth, attempt = 1, soft = false) {
  const { args, config } = curlRequestSpec(auth, `${BASE}${path}`);
  const raise = (message) => {
    if (soft) throw new Error(message);
    return fail(message);
  };

  let raw;
  try {
    raw = execFileSync("curl", args, {
      input: config,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    // Node's error message repeats the full command line, so never print it
    // verbatim; redact defensively even though the token is not in argv.
    const detail = redact(String(error.stderr ?? "").trim() || String(error.message ?? "").trim(), [auth.token]);
    return raise(`curl failed (exit ${error.status ?? "?"}): ${detail}`);
  }

  const cut = raw.lastIndexOf("\n");
  const status = Number(raw.slice(cut + 1).trim());
  const body = raw.slice(0, cut);

  // 429/5xx are transient; 401 on these endpoints is usually short-term rate
  // limiting, so it is reported instead of retried. Never loop.
  if ((status === 429 || status >= 500) && attempt < MAX_ATTEMPTS) {
    const waitMs = RETRY_BASE_MS * 2 ** (attempt - 1);
    console.error(`# HTTP ${status} from ${path}: retrying in ${waitMs}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
    sleepSync(waitMs);
    return apiGet(path, auth, attempt + 1, soft);
  }
  if (status === 401 || status === 403) {
    return raise(
      `HTTP ${status} from ${path} after ${attempt} attempt(s).\n` +
        `  - confirm the selected ${auth.source} identity with auth whoami; failures never switch sources.\n` +
        "  - 401 can mean invalid/expired credentials or temporary limiting; use the normal same-source login flow.\n" +
        "  - 403 can also be Cloudflare/proxy filtering: check that curl uses your proxy.",
    );
  }
  if (status < 200 || status >= 300) {
    return raise(`HTTP ${status} from ${path}: ${redact(body.slice(0, 300), [auth.token])}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    return raise(`response was not JSON: ${redact(body.slice(0, 200), [auth.token])}`);
  }
}

function intOption(value, name, { fallback, min }) {
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    fail(`--${name} needs a value`);
  }
  // A value option supplied without a value is recorded as null, not ignored.
  if (value === null) fail(`--${name} needs a value`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min) {
    fail(`--${name} must be a whole number >= ${min}, got ${JSON.stringify(value)}`);
  }
  return number;
}

const HELP = `chatgpt-context — read and carry ChatGPT discussion context

  chats list [--limit N] [--offset N] [--archived] [--filter TERM]
  chats filter <TERM> --input FILE|-
  chat outline <id> [--turns RANGE] [--include-tools]
  chat read <id> [--turns RANGE | --message ID | --unread SEGMENT ...]
       [--offset N] [--until N | --before N] [--include-tools] [--images DIR]
  chat tail <id> [--count N | --messages N] [--include-tools] [--images DIR]
  chat find <id> <TERM> [--turns RANGE] [--context-turns N] [--include-tools] [--images DIR]
  auth whoami
  help / --help

All commands support --json and --max-chars N (default ${DEFAULT_MAX_CHARS}).
Network commands support --auth-source auto|env|pi|codex. Auto chooses env, then Pi,
then Codex only if an earlier source is absent; a selected source never switches.
Local chats filter and help never read credentials or access the network.
chats list fetches one page (default --limit 30 --offset 0); --filter matches titles
literally and case-insensitively on that page, with one GET. chats filter reuses
format 7 list JSON from --input FILE or explicit stdin --input -. Neither performs
account-wide full-text search. chats search is not implemented.
--archived returns an unreliable sample, not a complete inventory.
chat read selects the whole current branch by default, oldest first within budget.
chat tail defaults to the latest ${DEFAULT_LAST_TURNS} turns; --messages counts messages instead.
RANGE is N, N:M, N:, or :M (1-based inclusive turns). Message offsets are original
UTF-16 coordinates; --before reads backwards and cannot combine with --offset/--until.
--turns/--message/tail/find continuations never expand their selected scope.
--unread accepts exact t:<from>:<to>, m:<id>:<from>:<to|*> and explicit s:<from>:<to>:<context>:<term> segments.
chat find returns literal matches with --context-turns (default 1) inside its range.
chat outline returns previews, not original text or a generated summary.
--images saves only selected downloadable images; failures preserve older files.
Complete output must fit the character budget, 40000 UTF-8 bytes and 1500 lines.
List output that cannot fit fails; reduce --limit rather than truncating JSON.
Use -- before dash-prefixed positional filter/find terms; multi-word terms survive.
Set CHATGPT_HISTORY_QUIET=1 to suppress only the credential-source stderr line.
Old top-level commands are rejected with migration guidance, not silent aliases.`;

/** Fetch one conversation and shape it into the active branch with turn numbers. */
function loadMessages(id, auth, includeTools = false) {
  const conversation = apiGet(`/conversation/${encodeURIComponent(id)}`, auth);
  const returnedId = conversation?.conversation_id;
  if (returnedId != null && (typeof returnedId !== "string" || returnedId.trim().toLowerCase() !== id.toLowerCase())) {
    fail("conversation response id does not match the requested id; refusing to continue");
  }
  let transcript;
  try {
    transcript = transcriptOf(conversation);
  } catch (error) {
    fail(`cannot read ${id}: ${error.message}`);
  }
  const tagged = withTurns(transcript.messages).messages;
  // Tool output is not what the user saw in ChatGPT, so it is omitted by default
  // and only counted; --include-tools puts it back. `imageMessages` keeps the full
  // list anyway, because generated images live in tool messages that the transcript
  // does not show.
  const tools = tagged.filter((message) => message.role === "tool");
  return {
    conversation,
    messages: includeTools ? tagged : tagged.filter((message) => message.role !== "tool"),
    imageMessages: tagged,
    branch: transcript.branch,
    toolMessages: includeTools ? 0 : tools.length,
    toolMessageIds: tools.map((message) => message.id),
  };
}

/** Resolve one scope into a plan and write it, or exit with the reason. */
/** `--images` needs a directory; a missing or empty value is a usage error. */
function imageDirOption(opts) {
  if (opts.images === undefined) return null;
  if (opts.images === null) fail("--images needs a directory");
  const value = String(opts.images).trim();
  if (!value) fail("--images needs a directory");
  return resolve(value);
}

/** A signed download URL is a credential for one file; keep it out of messages. */
function redactSignature(text) {
  return String(text ?? "").replace(/([?&]sig=)[^&\s"']+/gi, "$1[redacted]");
}

/**
 * Write one already-signed URL to disk. The Authorization header — and the signed
 * URL itself — travel through the curl config on stdin, exactly like every other
 * request, and curl writes the body straight to the file so a multi-megabyte image
 * never sits in this process. A file download gets more time than an API call.
 */
function downloadFile(url, path, auth, attempt = 1) {
  const { args, config } = curlRequestSpec(auth, url, { configUrl: true, timeoutSeconds: 300 });
  let status;
  try {
    const out = execFileSync("curl", [...args, "-o", path], {
      input: config,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    status = Number(out.trim());
  } catch (error) {
    const detail = redact(String(error.stderr ?? "").trim() || String(error.message ?? "").trim(), [auth.token]);
    throw new Error(redactSignature(detail));
  }
  if ((status === 429 || status >= 500) && attempt < MAX_ATTEMPTS) {
    sleepSync(RETRY_BASE_MS * 2 ** (attempt - 1));
    return downloadFile(url, path, auth, attempt + 1);
  }
  if (!Number.isInteger(status) || status < 200 || status >= 300) throw new Error(`HTTP ${status || "?"}`);
}

/**
 * Save every image the read kept, one warning per failure so a dead file never
 * costs the whole read. A failure is marked on the entry itself, so the header can
 * say `NOT SAVED` instead of pointing at a file that is not there.
 */
function downloadImages(images, auth) {
  let saved = 0;
  for (const image of images) {
    try {
      const meta = apiGet(`/files/${encodeURIComponent(image.fileId)}/download`, auth, 1, true);
      const url = String(meta?.download_url ?? "");
      if (!url) throw new Error(`no download_url (status ${meta?.status ?? "?"})`);
      // Only this exact HTTPS origin is verified to need the account bearer.
      // Do not forward it to CDN/subdomain URLs, other ports, or URL credentials.
      const target = new URL(url);
      if (target.protocol !== "https:") throw new Error("refusing a non-HTTPS download URL");
      if (target.origin !== "https://chatgpt.com" || target.username || target.password) {
        throw new Error(`refusing a download URL on ${target.host}`);
      }
      mkdirSync(dirname(image.path), { recursive: true });
      const stagingDir = mkdtempSync(join(dirname(image.path), ".chatgpt-history-"));
      try {
        const stagingPath = join(stagingDir, "download");
        downloadFile(url, stagingPath, auth);
        renameSync(stagingPath, image.path);
      } finally {
        rmSync(stagingDir, { recursive: true, force: true });
      }
      saved += 1;
    } catch (error) {
      image.failed = true;
      // One line per failure: a multi-line 401/403 hint would wreck the warning.
      const reason = redactSignature(String(error.message ?? error).replace(/\s*\n\s*/g, " ").trim());
      console.error(`# warning: image ${image.fileId} was not saved: ${reason}`);
    }
  }
  if (saved < images.length) {
    console.error(`# warning: ${images.length - saved} of ${images.length} image(s) could not be downloaded`);
  }
}

function emitScope({
  conversation,
  fallbackId,
  messages,
  imageMessages = [],
  scope,
  maxChars,
  json,
  branch = "current_node",
  toolMessages = 0,
  includeTools = false,
  imageDir = null,
  auth = null,
  planner = planRead,
  renderers = [renderReadText, renderReadJson],
}) {
  const render = json ? renderers[1] : renderers[0];
  let result;
  try {
    result = planner({
      id: fallbackId,
      title: conversation.title ?? "(untitled)",
      messages,
      scope,
      maxChars,
      branch,
      toolMessages,
      includeTools,
      imageDir,
      imageMessages,
      authSource: auth?.source ?? null,
      json: Boolean(json),
      // Reserve the largest possible image status before selecting transcript
      // windows, so later failures never overflow or invalidate the unread list.
      render: (plan) => render(plan, { reserveImageFailures: Boolean(imageDir) }),
    });
  } catch (error) {
    fail(error.message);
  }
  if (imageDir && result.plan.images?.length) downloadImages(result.plan.images, auth);
  // Never emit the budget-only rendering: report the actual download results.
  const document = render(result.plan);
  if (!outputFits(document, result.plan.maxChars)) {
    fail("internal error: the read exceeded its reserved output budget");
  }
  process.stdout.write(document);
}

function writeBounded(document, maxChars) {
  if (!outputFits(document, maxChars)) {
    fail("output cannot fit its character/byte/line budget; reduce --limit or increase --max-chars within the output guards");
  }
  process.stdout.write(document);
}

function emitChatList(page, opts, maxChars) {
  const document = opts.json ? `${JSON.stringify(page, null, 2)}\n` : `${renderChatListText(page)}\n`;
  writeBounded(document, maxChars);
}

function listNext(page, opts, maxChars) {
  if (page.page.nextOffset === null) return null;
  return `${SCRIPT_COMMAND} chats list --limit ${page.page.limit} --offset ${page.page.nextOffset}` +
    `${opts.filter === undefined ? "" : ` --filter ${shellQuote(opts.filter.trim())}`}` +
    ` --auth-source ${page.credentialSource}` +
    `${opts.json ? " --json" : ""}` +
    `${maxChars === DEFAULT_MAX_CHARS ? "" : ` --max-chars ${maxChars}`}`;
}

function runCommand() {
  const { positional: raw, opts, unknown } = parseArgs(process.argv.slice(2));
  if (opts.help || raw[0] === "help") {
    const maxChars = intOption(opts["max-chars"], "max-chars", { fallback: DEFAULT_MAX_CHARS, min: 1 });
    const document = opts.json
      ? `${JSON.stringify({ kind: "help", format: FORMAT_VERSION, commands: [...Object.keys(COMMAND_OPTIONS), "help"], text: HELP }, null, 2)}\n`
      : `${HELP}\n`;
    writeBounded(document, maxChars);
    return;
  }
  if (!raw.length) fail(HELP);
  if (Object.hasOwn(LEGACY_COMMANDS, raw[0])) {
    fail(`legacy command ${raw[0]} was replaced; migrate to ${LEGACY_COMMANDS[raw[0]]}`);
  }
  const command = raw.slice(0, 2).join(" ");
  const positional = [command, ...raw.slice(2)];
  if (command === "chats list" && opts.search !== undefined) fail("--search was replaced by chats list --filter TERM");
  if (command === "chat read" && (opts.last !== undefined || opts["last-turns"] !== undefined)) {
    fail("use chat tail ID --count N or --messages N instead of read --last-turns/--last; chat read defaults to the whole branch");
  }
  validateCommandOptions(command, positional, opts, unknown);
  const maxChars = intOption(opts["max-chars"], "max-chars", { fallback: DEFAULT_MAX_CHARS, min: 1 });
  const authenticate = () => {
    const auth = loadAuth(opts["auth-source"] ?? "auto");
    if (process.env.CHATGPT_HISTORY_QUIET !== "1") console.error(`# credentials: ${auth.source}${auth.refreshed ? " (refreshed)" : ""}`);
    return auth;
  };

  if (command === "chats filter") {
    const term = positional.slice(1).join(" ").trim();
    if (!term) fail("chats filter needs a nonempty title term");
    if (typeof opts.input !== "string" || !opts.input.trim()) fail("chats filter needs --input FILE or --input - for explicit stdin");
    let input;
    try {
      input = readFileSync(opts.input === "-" ? 0 : opts.input, "utf8");
    } catch (error) {
      fail(`cannot read --input (${error.code ?? "read failure"})`);
    }
    let page;
    try { page = JSON.parse(input); }
    catch { fail("--input must contain valid chat-list JSON (format 7)"); }
    emitChatList(filterChatList(page, term), opts, maxChars);
    return;
  }

  if (command === "chats list") {
    const limit = intOption(opts.limit, "limit", { fallback: DEFAULT_LIMIT, min: 1 });
    const offset = intOption(opts.offset, "offset", { fallback: 0, min: 0 });
    if (opts.filter !== undefined && !opts.filter.trim()) fail("--filter needs a nonempty title term");
    const auth = authenticate();
    const suffix = opts.archived ? "&is_archived=true" : "";
    const data = apiGet(`/conversations?offset=${offset}&limit=${limit}${suffix}`, auth);
    let page = createChatList({ items: data.items ?? [], offset, limit, total: data.total ?? null,
      archived: Boolean(opts.archived), credentialSource: auth.source });
    if (opts.filter !== undefined) page = filterChatList(page, opts.filter);
    page.next = listNext(page, opts, maxChars);
    emitChatList(page, opts, maxChars);
    return;
  }

  if (command === "auth whoami") {
    const auth = authenticate();
    const me = apiGet("/me", auth);
    writeBounded(`${JSON.stringify({ id: me.id, name: me.name, email: me.email, credentialSource: auth.source }, null, 2)}\n`, maxChars);
    return;
  }

  const id = positional[1]?.trim();
  if (!isConversationId(id)) fail(`not a conversation id: ${JSON.stringify(id)}`);
  const includeTools = opts["include-tools"] === true;
  const imageDir = imageDirOption(opts);
  let scope;

  if (command === "chat read") {
    const selectors = ["turns", "message", "unread"].filter((name) => opts[name] !== undefined);
    if (selectors.length > 1) fail(`pick one of --turns, --message or --unread (got ${selectors.map((name) => `--${name}`).join(", ")})`);
    if (opts.unread !== undefined && ["offset", "until", "before"].some((name) => opts[name] !== undefined)) {
      fail("--unread carries its own windows; it cannot be combined with --offset, --until, or --before");
    }
    for (const name of ["offset", "until", "before"]) {
      if (opts[name] !== undefined && opts.message === undefined) fail(`--${name} only applies together with --message`);
    }
    if (opts.before !== undefined && (opts.offset !== undefined || opts.until !== undefined)) {
      fail("--before cannot be combined with --offset or --until");
    }
    if (opts.unread !== undefined) {
      const segments = opts.unread.map((spec) => parseUnreadSegment(spec));
      if (segments.some((segment) => !segment)) fail("--unread expects t:<from>:<to>, m:<messageId>:<from>:<to|*>, or s:<from>:<to>:<context>:<term>");
      scope = { kind: "unread", segments };
    } else if (opts.message !== undefined) {
      const messageId = opts.message.trim();
      if (!messageId) fail("--message needs a message id");
      scope = { kind: "message", id: messageId,
        offset: intOption(opts.offset, "offset", { fallback: 0, min: 0 }),
        until: opts.until === undefined ? undefined : intOption(opts.until, "until", { min: 0 }),
        before: opts.before === undefined ? undefined : intOption(opts.before, "before", { min: 1 }) };
      if (scope.until !== undefined && scope.until <= scope.offset) fail("--until must be greater than --offset");
    } else {
      const range = opts.turns === undefined ? { from: 1, to: Number.POSITIVE_INFINITY } : parseTurnSpec(opts.turns);
      if (!range) fail("--turns expects N, N:M, N:, or :M");
      scope = { kind: "turns", ...range };
    }
  } else if (command === "chat tail") {
    if (opts.count !== undefined && opts.messages !== undefined) fail("pick one of --count or --messages");
    scope = opts.messages !== undefined
      ? { kind: "last-messages", count: intOption(opts.messages, "messages", { min: 1 }) }
      : { kind: "last-turns", count: intOption(opts.count, "count", { fallback: DEFAULT_LAST_TURNS, min: 1 }) };
  } else {
    const range = opts.turns === undefined ? { from: 1, to: Number.POSITIVE_INFINITY } : parseTurnSpec(opts.turns);
    if (!range) fail("--turns expects N, N:M, N:, or :M");
    if (command === "chat find") {
      const term = positional.slice(2).join(" ").trim();
      if (!term) fail("chat find needs a nonempty term");
      scope = { kind: "find", term, ...range,
        contextTurns: intOption(opts["context-turns"], "context-turns", { fallback: 1, min: 0 }) };
    } else {
      scope = { kind: "outline", ...range };
    }
  }

  const auth = authenticate();
  const { conversation, messages, imageMessages, branch, toolMessages, toolMessageIds } = loadMessages(id, auth, includeTools);
  if (scope.kind === "message" && !messages.some((message) => message.id === scope.id) && toolMessageIds.includes(scope.id)) {
    fail(`message ${scope.id} is tool output, which is omitted by default; add --include-tools`);
  }
  emitScope({ conversation, fallbackId: id, messages, imageMessages, scope, maxChars,
    json: opts.json, branch, toolMessages, includeTools, imageDir, auth,
    ...(command === "chat outline" ? { planner: planOutline, renderers: [renderOutlineText, renderOutlineJson] } : {}) });
}

function main() {
  try { runCommand(); }
  catch (error) { fail(error.message); }
}

/**
 * A skill directory may be reached through a junction/symlink (Pi loads skills
 * from several roots), so compare resolved paths: `import.meta.url` is already
 * real while argv[1] keeps the link.
 */
function isDirectInvocation() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  const invokedPath = resolve(invoked);
  const selfPath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(invokedPath) === realpathSync(selfPath);
  } catch {
    return invokedPath === selfPath;
  }
}

if (isDirectInvocation()) main();
