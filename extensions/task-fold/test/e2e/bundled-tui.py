#!/usr/bin/env python3
"""Run against the real Pi CLI with an isolated fake model and a pseudo-terminal (macOS/Linux)."""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[2]
RAIL = f"{'─' * 52} Workings {'─' * 54}"
rail = f"▹ {RAIL}"
PI = os.environ.get("PI_TASK_FOLD_PI") or shutil.which("pi")
if not PI:
    raise SystemExit("Pi executable not found; set PI_TASK_FOLD_PI")


def run(mode: str, compact: bool = False) -> None:
    with tempfile.TemporaryDirectory(prefix="pi-task-fold-e2e-") as temporary:
        directory = Path(temporary)
        (directory / "agent").mkdir()
        (directory / "cwd").mkdir()
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        env = {
            **os.environ,
            "PI_CODING_AGENT_DIR": str(directory / "agent"),
            "PI_OFFLINE": "1",
            "FOLD_E2E_DIR": str(directory),
            "TERM": "xterm-256color",
        }
        command = [
            PI, "--offline", "--no-session", "--tui-mode", mode, "-ne", "-ns", "-np", "--no-themes", "-nc",
            "--provider", "task-fold-e2e", "--model", "fold-model",
            "-e", str(ROOT / "index.ts"), "-e", str(ROOT / "test/e2e/fake-provider.ts"),
        ]
        if compact:
            command.extend(["-e", str(ROOT.parent / "compact-tool-ui/index.ts")])
        process = subprocess.Popen(
            command, stdin=slave, stdout=slave, stderr=slave, cwd=directory / "cwd", env=env, start_new_session=True,
        )
        os.close(slave)
        output = bytearray()

        def drain() -> None:
            while select.select([master], [], [], 0)[0]:
                try:
                    data = os.read(master, 65_536)
                except OSError:
                    return
                if not data:
                    return
                output.extend(data)

        def wait_for(name: str, timeout: float = 25) -> Path:
            target = directory / name
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                drain()
                if target.exists():
                    return target
                if process.poll() is not None:
                    raise RuntimeError(f"Pi exited with status {process.returncode}")
                time.sleep(0.03)
            raise TimeoutError(f"Timed out waiting for {name}")

        def send(value: str) -> None:
            os.write(master, (value + "\r").encode())

        def snapshot(name: str) -> str:
            send(f"/snapshot {name}")
            return wait_for(f"snapshot-{name}").read_text()

        try:
            wait_for("ready")
            time.sleep(0.5)
            send("test this task")
            wait_for("settled")
            time.sleep(0.2)
            folded = snapshot("folded")
            if compact:
                metadata = json.loads((directory / "snapshot-folded.json").read_text())
                assert "self" in metadata["toolShells"], "compact-tool-ui renderer was not actually active"
            assert re.search(r"▹ ─+ Workings ─+ · click or press Enter to expand", folded)
            assert "FOLD_E2E_ANSWER" in folded and "FOLD_E2E_PROGRESS" in folded
            assert folded.index("test this task") < folded.index("Workings") < folded.index("FOLD_E2E_PROGRESS")
            assert "/task-fold" not in folded and "过程已折叠" not in folded
            assert all(value not in folded for value in ["FOLD_E2E_THINK", "FOLD_E2E_FINAL_THINK", "FOLD_E2E_TOOL_OUTPUT"])

            send("/task-fold")
            time.sleep(0.15)
            expanded = snapshot("expanded")
            assert f"▿ {RAIL}" in expanded
            assert "click or press Enter to expand" not in expanded
            assert all(value in expanded for value in ["FOLD_E2E_THINK", "FOLD_E2E_FINAL_THINK", "FOLD_E2E_TOOL_OUTPUT"])
            indexes = [expanded.index(value) for value in ["FOLD_E2E_THINK", "FOLD_E2E_TOOL_OUTPUT", "FOLD_E2E_FINAL_THINK", "FOLD_E2E_ANSWER"]]
            assert indexes == sorted(indexes), indexes
            assert expanded.index(RAIL) < expanded.index("FOLD_E2E_THINK")

            (directory / "ready").unlink()
            send("/reload")
            wait_for("ready")
            time.sleep(0.5)
            reloaded = snapshot("reloaded")
            assert rail in reloaded and "click or press Enter to expand" not in reloaded
            assert "FOLD_E2E_THINK" not in reloaded and "FOLD_E2E_TOOL_OUTPUT" not in reloaded
            assert rail not in reloaded.split("FOLD_E2E_ANSWER", 1)[1]

            send("/task-fold")
            time.sleep(0.15)
            reloaded_expanded = snapshot("reloaded-expanded")
            assert f"▿ {RAIL}" in reloaded_expanded
            assert "FOLD_E2E_THINK" in reloaded_expanded and "FOLD_E2E_TOOL_OUTPUT" in reloaded_expanded
            send("/task-fold")
            time.sleep(0.15)

            (directory / "settled").unlink()
            send("second task")
            wait_for("settled")
            time.sleep(0.2)
            second = snapshot("second")
            assert f"▹ {RAIL}" in second and second.count(RAIL) == 2
            assert "click or press Enter to expand" not in second
            assert "FOLD_E2E_THINK" not in second

            (directory / "settled").unlink()
            send("third task")
            wait_for("settled")
            time.sleep(0.2)
            third = snapshot("third")
            assert third.count(rail) == 3, third
            assert third.count(RAIL) == 3
            lines = third.splitlines()
            rail_indexes = [index for index, line in enumerate(lines) if line.strip().startswith("▹ ") and RAIL in line]
            assert len(rail_indexes) == 3
            for index in rail_indexes:
                assert lines[index - 1].strip() == "", (index, lines[index - 1])
                prompt = next(line for line in reversed(lines[:index]) if line.strip())
                assert prompt.strip() in {"test this task", "second task", "third task"}, prompt
                after = next(line for line in lines[index + 1:] if line.strip())
                assert after.strip() == "FOLD_E2E_PROGRESS", after
            label = f"{mode} + compact-tool-ui" if compact else mode
            print(f"PASS: {label} — position, fold, expand order, hint persistence, reload restore, multi-turn rails")
        except BaseException:
            drain()
            print("Pi terminal output (tail):\n", output[-16_000:].decode(errors="replace"))
            raise
        finally:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            os.close(master)


if __name__ == "__main__":
    run("fullscreen")
    run("regular")
    if (ROOT.parent / "compact-tool-ui/index.ts").exists():
        run("fullscreen", compact=True)
