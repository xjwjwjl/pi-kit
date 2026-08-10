import assert from "node:assert/strict";
import test from "node:test";
import { RemoteOpsPathError, resolveRemotePath } from "../src/paths.js";

test("resolves remote paths within their configured POSIX cwd", () => {
	assert.equal(resolveRemotePath("/srv/app", "releases/app.tar.gz"), "/srv/app/releases/app.tar.gz");
	assert.equal(resolveRemotePath("/", "releases/app.tar.gz"), "/releases/app.tar.gz");
	assert.throws(() => resolveRemotePath("/srv/app", "../etc/passwd"), RemoteOpsPathError);
	assert.throws(() => resolveRemotePath("/srv/app", "/etc/passwd"), RemoteOpsPathError);
	assert.throws(() => resolveRemotePath("/srv/app", "folder\\file"), RemoteOpsPathError);
});
