package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	maxOutput    = 64 * 1024
	maxServerLog = 16 * 1024
)

func isBareProgram(program string) bool {
	for _, r := range program {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || strings.ContainsRune("._+-", r) {
			continue
		}
		return false
	}
	return program != ""
}

func allowedProgramPath(program string) bool {
	clean := filepath.ToSlash(filepath.Clean(program))
	for _, prefix := range []string{"/usr/bin/", "/bin/", "/usr/sbin/", "/sbin/", "/usr/local/bin/", "/usr/local/sbin/"} {
		if strings.HasPrefix(clean, prefix) && !strings.Contains(strings.TrimPrefix(clean, prefix), "/") {
			return true
		}
	}
	return false
}

func allowedResolvedProgramPath(program string) bool {
	clean := filepath.ToSlash(filepath.Clean(program))
	for _, prefix := range []string{
		"/usr/bin/", "/bin/", "/usr/sbin/", "/sbin/", "/usr/local/bin/", "/usr/local/sbin/",
		"/usr/lib/", "/usr/lib64/", "/usr/libexec/", "/lib/", "/lib64/",
	} {
		if strings.HasPrefix(clean, prefix) {
			return true
		}
	}
	return false
}

func isAllowedProgram(program string) bool {
	if _, ok := allowedPrograms[program]; !ok {
		return false
	}
	if _, forbidden := forbiddenPrograms[program]; forbidden {
		return false
	}
	return true
}

func hasUnsafeControl(value string) bool {
	for _, r := range value {
		if (r >= 0x01 && r <= 0x08) || (r >= 0x0b && r <= 0x0c) || (r >= 0x0e && r <= 0x1f) || r == 0x7f {
			return true
		}
	}
	return false
}

type outputCapture struct {
	data      []byte
	truncated bool
	logged    int
	stream    *os.File
}

func (c *outputCapture) Write(p []byte) (int, error) {
	if len(c.data) < maxOutput {
		remaining := maxOutput - len(c.data)
		if len(p) <= remaining {
			c.data = append(c.data, p...)
		} else {
			c.data = append(c.data, p[:remaining]...)
			c.truncated = true
		}
	} else if len(p) > 0 {
		c.truncated = true
	}
	if c.stream != nil && c.logged < maxServerLog {
		remaining := maxServerLog - c.logged
		chunk := p
		if len(chunk) > remaining {
			chunk = chunk[:remaining]
		}
		_, _ = c.stream.Write(chunk)
		c.logged += len(chunk)
	}
	return len(p), nil
}

func (c *outputCapture) String() string {
	text := string(c.data)
	if c.truncated {
		text += "\n...output truncated..."
	}
	return text
}

func formatCommand(program string, args []string) string {
	parts := make([]string, 0, len(args)+1)
	parts = append(parts, program)
	for _, arg := range args {
		parts = append(parts, strconv.Quote(arg))
	}
	return strings.Join(parts, " ")
}
