/**
 * Canonical command catalog shared by the client shell-parser and the
 * server piexec executable allowlist. Keep both sides in sync.
 *
 * @see piexec/main.go — allowedPrograms / forbiddenPrograms maps
 */
export const KNOWN_EXECUTABLES = new Set([
	"bash", "sh", "zsh", "dash", "env", "eval", "source", "exec", "xargs", "find",
	"python", "python2", "python3", "perl", "ruby", "node",
	"curl", "wget", "ssh", "sudo", "doas",
	"date", "mkfs", "dd", "wipefs", "fdisk", "parted", "shutdown", "reboot", "poweroff", "halt",
	"useradd", "userdel", "usermod", "groupadd", "groupdel", "passwd", "chpasswd",
	"ufw", "iptables", "nft", "firewall-cmd", "route", "ip",
	"nohup", "disown", "setsid", "rm", "mount", "umount", "modprobe", "sysctl",
	"kill", "pkill", "killall", "service", "systemd-run",
	"cp", "mv", "mkdir", "touch", "chmod", "chown", "ln", "install", "tee", "truncate", "sed",
	"pwd", "whoami", "id", "uname", "uptime", "df", "free", "ps", "pgrep", "ss", "ls", "stat",
	"file", "head", "tail", "grep", "rg", "cat", "less", "more", "sha256sum", "echo", "printf",
	"du", "wc", "pstree", "pidof", "which", "netstat", "lsof", "readlink", "realpath", "basename", "dirname",
	"date", "hostname", "systemctl", "journalctl", "docker", "docker-compose", "lsblk", "blkid",
	"smartctl", "hdparm", "mkfs.ext4", "mkfs.xfs", "mkfs.btrfs",
]);

export const ALLOWED_EXECUTABLE_PREFIXES = [
	"/usr/bin/", "/bin/", "/usr/sbin/", "/sbin/", "/usr/local/bin/", "/usr/local/sbin/",
];
