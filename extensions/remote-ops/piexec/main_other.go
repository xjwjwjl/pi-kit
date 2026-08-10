//go:build !linux

package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "rp-proxy only runs on Linux. Cross-compile with: GOOS=linux go build")
	os.Exit(1)
}

func resolveProgram(program string) (string, error) {
	// Stub for cross-platform compilation; the real implementation is in main.go (linux only).
	return "", fmt.Errorf("not supported on this platform")
}

var allowedPrograms = map[string]struct{}{}
var forbiddenPrograms = map[string]struct{}{}
