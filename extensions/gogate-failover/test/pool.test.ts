import test from "node:test";
import assert from "node:assert/strict";
import { modelKey, nextCandidate, resolvePool } from "../src/pool.ts";

function model(id: string) {
  return { provider: "gogate", id } as any;
}

test("selects the next unattempted model in pool order", () => {
  const a = model("a");
  const b = model("b");
  const c = model("c");

  const result = nextCandidate(
    [a, b, c],
    a,
    new Set([modelKey(a)]),
    new Map(),
    Date.now(),
  );

  assert.equal(result, b);
});

test("skips attempted and cooling-down models", () => {
  const a = model("a");
  const b = model("b");
  const c = model("c");
  const now = Date.now();

  const result = nextCandidate(
    [a, b, c],
    a,
    new Set([modelKey(a), modelKey(b)]),
    new Map([[modelKey(c), now + 60_000]]),
    now,
  );

  assert.equal(result, undefined);
});

test("allows a model after its cooldown expires", () => {
  const a = model("a");
  const b = model("b");
  const now = Date.now();

  const result = nextCandidate(
    [a, b],
    a,
    new Set([modelKey(a)]),
    new Map([[modelKey(b), now - 1]]),
    now,
  );

  assert.equal(result, b);
});

test("explicit pools can include models outside enabledModels", () => {
  const a = model("a");
  const b = model("b");
  const ctx = {
    model: a,
    scopedModels: [{ model: a }],
    modelRegistry: { getAvailable: () => [a, b] },
  } as any;

  const pool = resolvePool(ctx, {
    enabled: true,
    provider: "gogate",
    models: ["gogate/b"],
    cooldownMs: 1,
  });

  assert.deepEqual(pool.map(modelKey), ["gogate/a", "gogate/b"]);
});
