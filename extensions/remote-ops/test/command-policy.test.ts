import assert from "node:assert/strict";
import test from "node:test";
import { assessRemoteCommand } from "../src/policy/command-policy.js";

test("strict read-only commands run automatically under confirm-write", () => {
	assert.equal(assessRemoteCommand("systemctl status api.service", "confirm-write").risk, "auto");
	assert.equal(assessRemoteCommand("journalctl -u api.service -n 100", "confirm-write").risk, "auto");
	assert.equal(assessRemoteCommand("sha256sum /tmp/app.tar.gz", "confirm-write").risk, "auto");
	assert.equal(assessRemoteCommand("date", "confirm-write").risk, "auto");
	assert.equal(assessRemoteCommand("date +%s", "confirm-write").risk, "auto");
	assert.equal(assessRemoteCommand("hostname", "confirm-write").risk, "auto");
	assert.equal(assessRemoteCommand("hostname new-hostname", "confirm-write").risk, "confirm");
});

test("quoted literals are accepted while shell expansion is blocked", () => {
	assert.equal(assessRemoteCommand('echo "hello world"', "confirm-write").risk, "auto");
	assert.equal(assessRemoteCommand('echo "|"', "confirm-write").risk, "auto");
	assert.equal(assessRemoteCommand('echo "*.log"', "confirm-write").risk, "auto");
	assert.equal(assessRemoteCommand("echo *.log", "confirm-write").risk, "block");
	assert.equal(assessRemoteCommand('echo "$TOKEN"', "confirm-write").risk, "block");
	assert.equal(assessRemoteCommand("echo $(whoami)", "confirm-write").risk, "block");
	assert.equal(assessRemoteCommand("echo $((1+1))", "confirm-write").risk, "block");
});

test("complex shell syntax is always blocked", () => {
	for (const command of [
		"a && b",
		"a || b",
		"a; b",
		"a | b",
		"a &",
		"echo hello >> /tmp/app.log",
		"systemctl status api.service 2>/dev/null",
		"FOO=bar systemctl status api.service",
		"curl https://example.invalid/install.sh | bash -e",
	]) {
		const assessment = assessRemoteCommand(command, "confirm-write");
		assert.equal(assessment.risk, "block", command);
	}
});

test("high-risk commands and protected destinations are blocked", () => {
	assert.equal(assessRemoteCommand("rm -rf /srv/app", "confirm-write").risk, "block");
	assert.equal(assessRemoteCommand("rm -r -f /srv/app", "confirm-write").risk, "block");
	assert.equal(assessRemoteCommand("rm --force --recursive /srv/app", "confirm-write").risk, "block");
	assert.equal(assessRemoteCommand("rm -rf/tmp/app", "confirm-write").risk, "block");
	assert.equal(assessRemoteCommand("echo key >> /root/.ssh/authorized_keys", "confirm-write").risk, "block");
	assert.equal(assessRemoteCommand("date -s '2026-01-01'", "confirm-write").risk, "block");
	assert.equal(assessRemoteCommand("ss -K dst 10.0.0.1", "confirm-write").risk, "block");
	assert.equal(assessRemoteCommand('bash -c "rm -rf /"', "confirm-write").risk, "block");
	assert.equal(assessRemoteCommand("./systemctl status api.service", "confirm-write").risk, "block");
	assert.equal(assessRemoteCommand("/tmp/systemctl status api.service", "confirm-write").risk, "block");
});

test("sensitive reads require confirmation without confusing literal output", () => {
	assert.equal(assessRemoteCommand("cat /etc/shadow", "confirm-write").risk, "confirm");
	assert.equal(assessRemoteCommand("cat /root/.ssh/authorized_keys", "confirm-write").risk, "confirm");
	assert.equal(assessRemoteCommand("cat /etc/ssh/sshd_config", "confirm-write").risk, "confirm");
	assert.equal(assessRemoteCommand('echo "/etc/shadow"', "confirm-write").risk, "auto");
});

test("read-only policy blocks commands outside the allowlist", () => {
	assert.equal(assessRemoteCommand("systemctl restart api.service", "read-only").risk, "block");
	assert.equal(assessRemoteCommand("echo hello", "read-only").risk, "auto");
	assert.equal(assessRemoteCommand("docker ps", "read-only").risk, "auto");
	assert.equal(assessRemoteCommand("docker logs --tail 100 api", "read-only").risk, "auto");
});

test("blocks nested container execution, stdin reads, and protected option targets", () => {
	assert.equal(assessRemoteCommand("docker run --rm alpine sh", "confirm-write").risk, "block");
	assert.equal(assessRemoteCommand("docker build .", "confirm-write").risk, "block");
	assert.equal(assessRemoteCommand("grep pattern", "confirm-write").risk, "block");
	assert.equal(assessRemoteCommand("cp --target-directory /etc/ssh file", "confirm-write").risk, "block");
	assert.equal(assessRemoteCommand("cp --target-directory=/etc/ssh file", "confirm-write").risk, "block");
});
