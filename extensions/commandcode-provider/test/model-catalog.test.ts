import assert from "node:assert/strict";
import { test } from "node:test";
import { createCommandCodeModel } from "../src/model-catalog.ts";

test("createCommandCodeModel maps Command Code model metadata", () => {
    const model = createCommandCodeModel({
        id: "deepseek/deepseek-v4-flash-vision-exp",
        name: "DeepSeek V4 Flash Vision",
        context_length: 1_000_000,
    });

    assert.equal(model.provider, "commandcode");
    assert.equal(model.api, "openai-completions");
    assert.equal(model.contextWindow, 1_000_000);
    assert.equal(model.maxTokens, 128_000);
    assert.deepEqual(model.input, ["text", "image"]);
    assert.equal(model.compat?.supportsDeveloperRole, false);
    assert.equal(model.compat?.supportsReasoningEffort, true);
});

test("createCommandCodeModel uses safe defaults for incomplete metadata", () => {
    const model = createCommandCodeModel({ id: "model-without-metadata" });

    assert.equal(model.name, "model-without-metadata");
    assert.equal(model.contextWindow, 1_000_000);
    assert.equal(model.maxTokens, 128_000);
    assert.deepEqual(model.input, ["text"]);
    assert.equal(model.compat?.supportsReasoningEffort, true);
    assert.equal(model.compat?.thinkingFormat, undefined);
    assert.equal(model.thinkingLevelMap, undefined);
});

test("createCommandCodeModel uses zai thinking format for GLM models", () => {
    const model = createCommandCodeModel({
        id: "z-ai/glm-5.3-flash",
        name: "GLM-5.3 Flash",
        context_length: 1_048_576,
    });

    assert.equal(model.compat?.thinkingFormat, "zai");
    assert.equal(model.compat?.supportsReasoningEffort, true);
    assert.deepEqual(model.thinkingLevelMap, {
        off: null,
        minimal: null,
        low: null,
        medium: null,
        high: "high",
        max: "max",
    });
});

test("createCommandCodeModel uses deepseek thinking format for DeepSeek models", () => {
    const model = createCommandCodeModel({
        id: "deepseek/deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        context_length: 1_000_000,
    });

    assert.equal(model.compat?.thinkingFormat, "deepseek");
    assert.equal(model.compat?.supportsReasoningEffort, true);
    assert.deepEqual(model.thinkingLevelMap, {
        off: null,
        minimal: null,
        low: "low",
        medium: null,
        high: "high",
        max: "max",
    });
});
