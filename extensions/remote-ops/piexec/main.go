//go:build linux

package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

type execRequest struct {
	Program string   `json:"program"`
	Args    []string `json:"args"`
	CWD     string   `json:"cwd"`
	Timeout int      `json:"timeout"` // seconds, 0 = default
}

type execResponse struct {
	ExitCode int    `json:"exitCode"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	TimedOut bool   `json:"timedOut"`
}

type healthResponse struct {
	Status   string `json:"status"`
	Hostname string `json:"hostname"`
	OS       string `json:"os"`
	PID      int    `json:"pid"`
}

const (
	maxArguments      = 100
	maxArgumentLen    = 1024
	maxTimeoutSeconds = 3600
)

var version = "0.2.0"

// allowedPrograms and forbiddenPrograms must stay in sync with
// src/policy/executable-catalog.ts — KNOWN_EXECUTABLES.
var allowedPrograms = map[string]struct{}{
	"bash": {}, "sh": {}, "zsh": {}, "dash": {}, "env": {}, "eval": {}, "source": {}, "exec": {}, "xargs": {}, "find": {},
	"python": {}, "python2": {}, "python3": {}, "perl": {}, "ruby": {}, "node": {},
	"curl": {}, "wget": {}, "ssh": {}, "sudo": {}, "doas": {},
	"date": {}, "mkfs": {}, "dd": {}, "wipefs": {}, "fdisk": {}, "parted": {}, "shutdown": {}, "reboot": {}, "poweroff": {}, "halt": {},
	"useradd": {}, "userdel": {}, "usermod": {}, "groupadd": {}, "groupdel": {}, "passwd": {}, "chpasswd": {},
	"ufw": {}, "iptables": {}, "nft": {}, "firewall-cmd": {}, "route": {}, "ip": {},
	"nohup": {}, "disown": {}, "setsid": {}, "rm": {}, "mount": {}, "umount": {}, "modprobe": {}, "sysctl": {},
	"kill": {}, "pkill": {}, "killall": {}, "service": {}, "systemd-run": {},
	"cp": {}, "mv": {}, "mkdir": {}, "touch": {}, "chmod": {}, "chown": {}, "ln": {}, "install": {}, "tee": {}, "truncate": {}, "sed": {},
	"pwd": {}, "whoami": {}, "id": {}, "uname": {}, "uptime": {}, "df": {}, "free": {}, "ps": {}, "pgrep": {}, "ss": {}, "ls": {}, "stat": {},
	"file": {}, "head": {}, "tail": {}, "grep": {}, "rg": {}, "cat": {}, "less": {}, "more": {}, "sha256sum": {}, "echo": {}, "printf": {},
	"du": {}, "wc": {}, "pstree": {}, "pidof": {}, "which": {}, "netstat": {}, "lsof": {}, "readlink": {}, "realpath": {}, "basename": {}, "dirname": {},
	"hostname": {}, "systemctl": {}, "journalctl": {}, "docker": {}, "docker-compose": {}, "lsblk": {}, "blkid": {},
	"smartctl": {}, "hdparm": {}, "mkfs.ext4": {}, "mkfs.xfs": {}, "mkfs.btrfs": {},
}

var forbiddenPrograms = map[string]struct{}{
	"bash": {}, "sh": {}, "zsh": {}, "dash": {}, "env": {}, "eval": {}, "source": {}, "exec": {}, "xargs": {}, "find": {},
	"python": {}, "python2": {}, "python3": {}, "perl": {}, "ruby": {}, "node": {},
	"ssh": {}, "sudo": {}, "doas": {}, "systemd-run": {}, "nohup": {}, "disown": {}, "setsid": {},
}

func main() {
	token := flag.String("token", "", "Bearer token for authentication (required)")
	port := flag.Int("port", 9090, "Listen port")
	flag.Parse()

	if *token == "" {
		fmt.Fprintln(os.Stderr, "Error: --token is required. Generate one with: openssl rand -hex 32")
		os.Exit(1)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/exec", withAuth(*token, handleExec))
	mux.HandleFunc("/health", withAuth(*token, handleHealth))

	addr := fmt.Sprintf(":%d", *port)
	srv := &http.Server{
		Addr:         addr,
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 0, // streaming
		IdleTimeout:  120 * time.Second,
	}

	go func() {
		quit := make(chan os.Signal, 1)
		signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
		<-quit
		log.Println("shutting down...")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(ctx)
	}()

	hostname, _ := os.Hostname()
	log.Printf("piexec v%s starting on %s (pid %d, host %s)", version, addr, os.Getpid(), hostname)
	if err := srv.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatalf("listen error: %v", err)
	}
	log.Println("stopped")
}

func withAuth(token string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "Bearer ") || strings.TrimPrefix(auth, "Bearer ") != token {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	hostname, _ := os.Hostname()
	writeJSON(w, http.StatusOK, healthResponse{
		Status:   "ok",
		Hostname: hostname,
		OS:       "linux",
		PID:      os.Getpid(),
	})
}

func handleExec(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req execRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 32*1024)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request: " + err.Error()})
		return
	}
	program, err := resolveProgram(req.Program)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if len(req.Args) > maxArguments {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "too many arguments"})
		return
	}
	for _, arg := range req.Args {
		if strings.IndexByte(arg, 0) >= 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "argument contains NUL byte"})
			return
		}
		if hasUnsafeControl(arg) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "argument contains a control character"})
			return
		}
		if len(arg) > maxArgumentLen {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "argument is too long"})
			return
		}
	}

	cwd := req.CWD
	if cwd == "" {
		cwd = "/"
	}
	timeoutSeconds := req.Timeout
	if timeoutSeconds <= 0 {
		timeoutSeconds = 60
	}
	if timeoutSeconds > maxTimeoutSeconds {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "timeout is too large"})
		return
	}
	timeout := time.Duration(timeoutSeconds) * time.Second

	now := time.Now().Format("15:04:05")
	fmt.Fprintf(os.Stdout, "\n══════ %s %s\n  %s\n\n", now, strings.Repeat("═", 50), formatCommand(program, req.Args))

	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, program, req.Args...)
	cmd.Dir = cwd
	cmd.Env = []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"LANG=C",
		"LC_ALL=C",
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "stdout pipe failed"})
		return
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		_ = stdoutPipe.Close()
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "stderr pipe failed"})
		return
	}

	startErr := cmd.Start()
	if startErr != nil {
		_ = stdoutPipe.Close()
		_ = stderrPipe.Close()
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": startErr.Error()})
		return
	}

	var stdout, stderr outputCapture
	stdout.stream = os.Stdout
	stderr.stream = os.Stderr
	stdoutDone := make(chan struct{})
	stderrDone := make(chan struct{})
	go func() {
		defer close(stdoutDone)
		_, _ = io.Copy(&stdout, stdoutPipe)
	}()
	go func() {
		defer close(stderrDone)
		_, _ = io.Copy(&stderr, stderrPipe)
	}()

	// Kill process group on context timeout/cancel
	done := make(chan error, 1)
	go func() {
		<-stdoutDone
		<-stderrDone
		done <- cmd.Wait()
	}()

	var exitCode int
	timedOut := false
	select {
	case err := <-done:
		if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				if status, ok := exitErr.Sys().(syscall.WaitStatus); ok {
					exitCode = status.ExitStatus()
				} else {
					exitCode = -1
				}
			} else {
				exitCode = -1
			}
		}
	case <-ctx.Done():
		timedOut = true
		exitCode = -1
		// Kill process group
		if cmd.Process != nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
		_ = stdoutPipe.Close()
		_ = stderrPipe.Close()
		<-done
	}

	outStr := stdout.String()
	errStr := stderr.String()

	writeJSON(w, http.StatusOK, execResponse{
		ExitCode: exitCode,
		Stdout:   outStr,
		Stderr:   errStr,
		TimedOut: timedOut,
	})

	if timedOut {
		fmt.Fprintf(os.Stdout, "\n══════ ⏱ timeout after %v\n", timeout)
	} else {
		fmt.Fprintf(os.Stdout, "\n══════ exit %d · %d bytes\n", exitCode, len(outStr)+len(errStr))
	}
}

func resolveProgram(program string) (string, error) {
	if program == "" || strings.TrimSpace(program) != program || strings.IndexByte(program, 0) >= 0 {
		return "", fmt.Errorf("program is required")
	}
	if filepath.IsAbs(program) {
		basename := filepath.Base(filepath.Clean(program))
		if !isAllowedProgram(basename) {
			return "", fmt.Errorf("program is not allowed: %s", basename)
		}
		return verifyProgramPath(program)
	}
	if strings.ContainsAny(program, `/\\`) || !isBareProgram(program) {
		return "", fmt.Errorf("program must be a bare executable name")
	}
	if !isAllowedProgram(program) {
		return "", fmt.Errorf("program is not allowed: %s", program)
	}

	for _, directory := range []string{"/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"} {
		candidate := filepath.Join(directory, program)
		if resolved, err := verifyProgramPath(candidate); err == nil {
			return resolved, nil
		}
	}
	return "", fmt.Errorf("program is not available: %s", program)
}

func verifyProgramPath(program string) (string, error) {
	clean := filepath.Clean(program)
	if !allowedProgramPath(clean) {
		return "", fmt.Errorf("program path is not allowed")
	}
	info, err := os.Stat(clean)
	if err != nil || info.IsDir() || info.Mode()&0111 == 0 {
		return "", fmt.Errorf("program is not executable")
	}
	resolved, err := filepath.EvalSymlinks(clean)
	if err != nil || !allowedResolvedProgramPath(resolved) {
		return "", fmt.Errorf("resolved program path is not allowed")
	}
	return resolved, nil
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
