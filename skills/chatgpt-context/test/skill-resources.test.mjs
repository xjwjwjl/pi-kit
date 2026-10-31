import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skillDir = fileURLToPath(new URL("../", import.meta.url));
const documents = ["SKILL.md", "README.md", "references/cli.md", "references/endpoints.md"];
const read = (name) => readFileSync(resolve(skillDir, name), "utf8");
const prose = (name) => read(name).replace(/\s+/g, " ");
const skill = () => prose("SKILL.md");
const cli = () => prose("references/cli.md");

test("skill directory, manifest, metadata and CLI retain the identity", () => {
  const manifest = JSON.parse(read("package.json"));
  assert.equal(basename(resolve(skillDir)), "chatgpt-context");
  assert.equal(manifest.name, "chatgpt-context");
  assert.equal(manifest.version, "0.11.0");
  assert.ok(existsSync(resolve(skillDir, "scripts/chat-list.mjs")));
  assert.match(read("SKILL.md"), /^name: chatgpt-context$/m);
  assert.match(read("SKILL.md"), /^  version: "0\.11\.0"$/m);
  assert.match(manifest.scripts.check, /node --check scripts\/chatgpt-context\.mjs/);
  assert.ok(existsSync(resolve(skillDir, "scripts/chatgpt-context.mjs")));
  assert.ok(!existsSync(resolve(skillDir, "scripts/chatgpt-history.mjs")));
});

test("skill activation remains manual-only in frontmatter", () => {
  const frontmatter = read("SKILL.md").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  assert.ok(frontmatter);
  assert.match(frontmatter, /^disable-model-invocation: true$/m);
  assert.match(prose("README.md"), /manual-only/i);
});

test("routing metadata and bundled documentation remain English without ownership framing", () => {
  const description = read("SKILL.md").match(/^description: (".*")$/m);
  assert.ok(description);
  const value = JSON.parse(description[1]);
  assert.ok(value.length > 0 && value.length <= 1024);
  for (const name of documents) {
    const content = read(name);
    assert.doesNotMatch(content, /[\u3400-\u9fff]/u, name);
    assert.doesNotMatch(content, /\b(?:own|personal)\s+(?:ChatGPT\s+)?(?:account|conversations?|history)\b|\buser(?:'|’)?s\s+(?:ChatGPT\s+)?(?:account|conversations?|history)\b/i, name);
  }
});

test("discovery reuses bounded title pages and checks identity before widening access", () => {
  const content = skill();
  assert.match(content, /chats list --filter TERM/);
  assert.match(content, /chats filter TERM --input FILE/);
  assert.match(content, /each title page once/i);
  assert.match(content, /one or two relevant pages/i);
  assert.match(content, /auth whoami.*identity/);
  assert.match(content, /budget.*exhausted.*ask for a conversation link\/ID/);
  assert.match(content, /Do not cycle through keywords/);
  assert.match(content, /not batch-read.*histor/i);
});

test("design continuation targets latest corrections without mandatory full reads", () => {
  const content = skill();
  assert.match(content, /outline/i);
  assert.match(content, /latest user corrections/);
  assert.match(content, /earlier constraints/);
  assert.match(content, /superseded proposals/);
  assert.match(content, /not on every invocation/);
  assert.match(content, /current authorization/);
  assert.match(content, /not automatic authorization/);
});

test("CLI guidance preserves intact JSON, diagnostics and exit status", () => {
  const content = skill();
  for (const token of ["`head`", "`grep`", "`rg`", "`2>&1`", "`2>/dev/null`"]) {
    assert.ok(content.includes(token), token);
  }
  assert.match(content, /do not pipe/i);
  assert.match(content, /stdout and stderr separately/);
  assert.match(content, /credential-source metadata/);
  assert.match(content, /check the CLI exit status/);
  assert.match(content, /--max-chars.*chats list.*--limit.*--offset/);
});

test("command table exposes only the new hierarchy and explicit local input", () => {
  // Stop before defaults so migration examples cannot masquerade as active commands.
  const rows = read("references/cli.md").split("Defaults:")[0]
    .match(/^\| `[^`]+`[^\n]*/gm) ?? [];
  const commands = rows.map((row) => row.match(/`([^`]+)`/)[1]);
  assert.deepEqual(commands, [
    "chats list", "chats filter TERM --input FILE\\|-", "chat outline ID",
    "chat read ID", "chat tail ID", "chat find ID TERM", "auth whoami", "help",
  ]);
  const content = cli();
  assert.match(content, /--limit 30/);
  assert.match(content, /--offset 0/);
  assert.match(content, /Missing input is an error/);
  assert.match(content, /must not wait for terminal stdin/);
  assert.match(content, /zero authentication or network access/);
  assert.match(content, /help.*without credential access/i);
});

test("list envelope and pure filter preserve page coverage, not input commands", () => {
  const content = cli();
  assert.match(content, /kind: "chat-list", format: 7, credentialSource, archived/);
  for (const field of ["offset", "limit", "titlesScanned", "total", "returned", "nextOffset"]) {
    assert.match(content, new RegExp(`\\b${field}\\b`));
  }
  assert.match(content, /filters, note, items, next/);
  assert.match(content, /one GET for one page/);
  assert.match(content, /titles only.*fetched page/);
  assert.match(content, /strictly validates.*format 7/);
  assert.match(content, /older formats.*rejected/);
  assert.match(content, /never copies or runs.*input `next`/);
  assert.match(content, /never automatically fetches another page/);
  assert.match(content, /`next` to `null`/);
  assert.match(content, /preserves source\/page coverage metadata/i);
});

test("read, tail and find selection boundaries are explicit", () => {
  const content = cli();
  assert.match(content, /without a selector selects the \*\*entire current branch\*\*/);
  assert.match(content, /oldest first/);
  assert.match(content, /latest 3 turns by default/);
  assert.match(content, /--count N.*--messages N/);
  assert.match(content, /mutually exclusive/);
  assert.match(content, /Tail continuation only finishes that selected tail/);
  assert.match(content, /never adds unselected earlier history/);
  assert.match(content, /bounded find ends when its selected range/);
  assert.match(content, /never implicitly searches a prefix/);
  assert.match(content, /including after zero hits/);
  assert.match(content, /literal substrings/);
});

test("format 7 budgets cover list/filter and cannot hide hits as empty success", () => {
  const content = cli();
  for (const value of ["16000", "40000", "1500"]) assert.ok(content.includes(value));
  assert.match(content, /All output is guarded/);
  assert.match(content, /List\/filter outputs are also guarded/);
  assert.match(content, /never silently drop items/);
  assert.match(content, /reduce the list limit/);
  assert.match(content, /Budget exhaustion must not hide known hits/);
  assert.match(content, /credentialSource, complete/);
  assert.match(content, /`complete` means only the selected range\/view/);
});

test("source choice is pinned, refresh is same-source, secrets stay inside the CLI", () => {
  const content = cli();
  assert.match(content, /--auth-source auto\|env\|pi\|codex/);
  assert.match(skill(), /ENV > Pi > Codex/);
  assert.match(content, /no cross-source fallback/);
  assert.match(content, /Explicit `env` or `codex` reads only its corresponding source/);
  assert.match(content, /same-source OAuth refresh/);
  assert.match(content, /refresh failure is a clear error/);
  assert.match(content, /browser cookies/);
  assert.match(content, /agent must not inspect real auth or session contents/);
});

test("continuations validate source, scope and view without claiming durable checkpoints", () => {
  const content = cli();
  for (const role of ["system", "user", "assistant", "tool"]) {
    assert.ok(content.includes(`\`${role}\``));
  }
  assert.match(content, /embedded `next` hints.*untrusted evidence/);
  assert.match(content, /only its top-level `next`/);
  assert.match(content, /actual.*source.*--auth-source env\|pi\|codex.*never `auto`/);
  for (const option of ["--json", "--include-tools", "image destination", "budget"]) {
    assert.ok(content.includes(option));
  }
  assert.match(content, /no persistent checkpoints/);
  assert.match(content, /messages can be edited and branches changed/);
});

test("message fidelity and selected image rules remain documented", () => {
  const content = cli();
  assert.match(content, /UTF-16 code-unit coordinates/);
  for (const option of ["--message", "--offset", "--until", "--before", "--include-tools"]) {
    assert.ok(content.includes(option));
  }
  assert.match(content, /--before.*cannot be combined with `--offset` or `--until`/);
  assert.match(content, /Outline does not download images/);
  assert.match(content, /only the images included by the returned selection/);
  assert.match(content, /missing parent or cycle is an error/);
});

test("legacy commands error with migration guidance and unsupported search stays absent", () => {
  const content = cli();
  assert.match(content, /migration errors, not silent aliases/);
  assert.match(content, /list --search TERM.*chats list --filter TERM/);
  assert.match(content, /Bare `read ID`.*chat tail ID/);
  assert.match(content, /--last-turns N.*--count N/);
  assert.match(content, /--last N.*--messages N/);
  assert.match(content, /no `chats search`, `\/global\/search`/);
  const endpoints = prose("references/endpoints.md");
  assert.match(endpoints, /previously recorded/);
  assert.match(endpoints, /not reverified now/);
  assert.match(endpoints, /not new live endpoint observations/);
  assert.match(endpoints, /format 7/);
});

test("bundled Markdown reference links resolve locally", () => {
  let checked = 0;
  for (const name of documents) {
    for (const match of read(name).matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].split("#")[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const absolute = resolve(dirname(resolve(skillDir, name)), decodeURIComponent(target));
      assert.ok(existsSync(absolute), `${name}: missing ${target}`);
      checked += 1;
    }
  }
  assert.ok(checked > 0);
});

test("documented script paths resolve to the packaged entrypoint or pure helper", () => {
  let checked = 0;
  for (const name of documents) {
    for (const match of read(name).matchAll(/scripts\/[a-z0-9-]+\.mjs/g)) {
      assert.ok(["scripts/chatgpt-context.mjs", "scripts/chat-list.mjs"].includes(match[0]), name);
      assert.ok(existsSync(resolve(skillDir, match[0])));
      checked += 1;
    }
  }
  assert.ok(checked > 0);
});
