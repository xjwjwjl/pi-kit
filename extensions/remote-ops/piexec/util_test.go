package main

import (
	"os"
	"testing"
)

func TestIsBareProgram(t *testing.T) {
	ok := []string{"ls", "systemctl", "docker-compose", "rm", "grep", "rg", "sha256sum", "mkfs.ext4", "python3"}
	for _, name := range ok {
		if !isBareProgram(name) {
			t.Errorf("expected true for %q", name)
		}
	}
	bad := []string{"", "./ls", "../tool", "foo/bar", "rm -rf", "bad$name", "bad;name"}
	for _, name := range bad {
		if isBareProgram(name) {
			t.Errorf("expected false for %q", name)
		}
	}
}

func TestAllowedProgramPath(t *testing.T) {
	ok := []string{
		"/usr/bin/systemctl", "/bin/ls", "/usr/sbin/sshd", "/sbin/ip",
		"/usr/local/bin/docker", "/usr/local/sbin/unbound",
	}
	for _, path := range ok {
		if !allowedProgramPath(path) {
			t.Errorf("expected true for %q", path)
		}
	}
	bad := []string{
		"/tmp/systemctl", "/opt/bin/ls", "/usr/bin/subdir/ls", "/", "/usr", "/home/user/tool",
	}
	for _, path := range bad {
		if allowedProgramPath(path) {
			t.Errorf("expected false for %q", path)
		}
	}
}

func TestAllowedResolvedProgramPath(t *testing.T) {
	ok := []string{
		"/usr/bin/bash", "/usr/lib/systemd/systemd", "/lib64/libfoo.so", "/usr/libexec/foo",
	}
	for _, path := range ok {
		if !allowedResolvedProgramPath(path) {
			t.Errorf("expected true for %q", path)
		}
	}
	bad := []string{"/opt/foo", "/home/user/bin/tool", "/tmp/x"}
	for _, path := range bad {
		if allowedResolvedProgramPath(path) {
			t.Errorf("expected false for %q", path)
		}
	}
}

func TestIsAllowedProgram(t *testing.T) {
	// These need the maps to be populated; they are in main.go (linux only).
	// Skip if maps are empty.
	if len(allowedPrograms) == 0 {
		t.Skip("allowedPrograms not populated (not on linux)")
	}
	if isAllowedProgram("bash") {
		t.Error("bash should be forbidden")
	}
	if !isAllowedProgram("ls") {
		t.Error("ls should be allowed")
	}
	if isAllowedProgram("unknown-tool") {
		t.Error("unknown-tool should not be allowed")
	}
}

func TestHasUnsafeControl(t *testing.T) {
	if hasUnsafeControl("hello") {
		t.Error("hello should be safe")
	}
	if !hasUnsafeControl("\x01") {
		t.Error("0x01 should be unsafe")
	}
	if !hasUnsafeControl("\x1f") {
		t.Error("0x1f should be unsafe")
	}
	if !hasUnsafeControl("\x7f") {
		t.Error("DEL should be unsafe")
	}
	// Printable should be safe
	for r := rune(0x20); r < 0x7f; r++ {
		if r == 0x7f {
			continue
		}
		if hasUnsafeControl(string(r)) {
			t.Errorf("U+%04x should be safe", r)
		}
	}
}

func TestOutputCapture(t *testing.T) {
	var c outputCapture
	c.Write([]byte("hello"))
	if c.String() != "hello" {
		t.Errorf("got %q, want %q", c.String(), "hello")
	}
	if c.truncated {
		t.Error("should not be truncated for 5 bytes")
	}
}

func TestOutputCaptureTruncation(t *testing.T) {
	var c outputCapture
	big := make([]byte, maxOutput+1024)
	for i := range big {
		big[i] = 'x'
	}
	c.Write(big)
	out := c.String()
	if len(out) <= maxOutput {
		t.Errorf("output too short: %d bytes", len(out))
	}
	if !c.truncated {
		t.Error("should be truncated")
	}
}

func TestOutputCaptureServerLog(t *testing.T) {
	f, err := os.CreateTemp("", "piexec-test-log")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(f.Name())

	var c outputCapture
	c.stream = f
	payload := make([]byte, maxServerLog+1024)
	for i := range payload {
		payload[i] = 'A'
	}
	c.Write(payload)

	info, _ := f.Stat()
	if info.Size() > int64(maxServerLog)+128 {
		t.Errorf("server log too large: %d bytes", info.Size())
	}
}

func TestFormatCommand(t *testing.T) {
	out := formatCommand("/usr/bin/systemctl", []string{"status", "nginx"})
	expected := `/usr/bin/systemctl "status" "nginx"`
	if out != expected {
		t.Errorf("got %q, want %q", out, expected)
	}

	out2 := formatCommand("ls", []string{"/etc/ssh/sshd_config"})
	expected2 := `ls "/etc/ssh/sshd_config"`
	if out2 != expected2 {
		t.Errorf("got %q, want %q", out2, expected2)
	}
}
