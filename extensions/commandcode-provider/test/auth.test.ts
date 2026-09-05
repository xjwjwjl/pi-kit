import assert from "node:assert/strict";
import { test } from "node:test";
import {
    buildCommandCodeLoginUrl,
    loginCommandCode,
    parseCommandCodeCallback,
} from "../src/auth.ts";

function abortSignal(): AbortSignal {
    return new AbortController().signal;
}

test("buildCommandCodeLoginUrl includes callback and state", () => {
    const url = new URL(buildCommandCodeLoginUrl({ port: 5960, state: "state-1" }));

    assert.equal(url.origin, "https://commandcode.ai");
    assert.equal(url.pathname, "/studio/auth/cli");
    assert.equal(url.searchParams.get("callback"), "http://localhost:5960/callback");
    assert.equal(url.searchParams.get("state"), "state-1");
});

test("parseCommandCodeCallback validates state and preserves the api key", () => {
    const callback = parseCommandCodeCallback(
        { apiKey: " user-key ", state: "state-1", userName: "lin" },
        "state-1",
    );

    assert.deepEqual(callback, {
        apiKey: "user-key",
        state: "state-1",
        userName: "lin",
    });
    assert.throws(
        () => parseCommandCodeCallback({ apiKey: "key", state: "wrong" }, "state-1"),
        /state did not match/,
    );
});

test("loginCommandCode returns the callback key without a post-login network request", async () => {
    let callbackUrl: string | undefined;
    const notifications: unknown[] = [];

    const interaction = {
        signal: abortSignal(),
        notify(event: any) {
            notifications.push(event);
            if (event.type !== "auth_url") return;
            const loginUrl = new URL(event.url);
            callbackUrl = loginUrl.searchParams.get("callback") ?? undefined;
            const state = loginUrl.searchParams.get("state");
            assert.ok(callbackUrl);
            assert.ok(state);

            void fetch(callbackUrl.replace("localhost", "127.0.0.1"), {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ apiKey: "browser-key", state }),
            });
        },
        async prompt(): Promise<string> {
            throw new Error("login should not ask for a manual key");
        },
    };

    const credential = await loginCommandCode(interaction, { timeoutMs: 2_000 });

    assert.deepEqual(credential, { type: "api_key", key: "browser-key" });
    assert.equal(callbackUrl?.endsWith("/callback"), true);
    assert.deepEqual(
        notifications.map((event: any) => event.type),
        ["auth_url", "progress"],
    );
});
