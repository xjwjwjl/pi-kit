import { readFileSync, writeFileSync } from "node:fs";
import { withDirectoryLock } from "../src/file-lock.ts";

type State = { active: number; maxActive: number; acquired: number };

const [lockPath, statePath, holdMsText] = process.argv.slice(2);
const holdMs = Number(holdMsText);
if (!lockPath || !statePath || !Number.isFinite(holdMs)) {
  process.exitCode = 2;
} else {
  const result = await withDirectoryLock(lockPath, async () => {
    const state = JSON.parse(readFileSync(statePath, "utf-8")) as State;
    state.active += 1;
    state.maxActive = Math.max(state.maxActive, state.active);
    writeFileSync(statePath, JSON.stringify(state), "utf-8");

    await new Promise((resolve) => setTimeout(resolve, holdMs));

    state.active -= 1;
    state.acquired += 1;
    writeFileSync(statePath, JSON.stringify(state), "utf-8");
    return true;
  });

  if (result !== true) process.exitCode = 3;
}
