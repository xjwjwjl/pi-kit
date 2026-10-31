import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ArtifactBundle {
  run: unknown;
  prompt: string;
  events: string;
  session: string;
  stdout: string;
  stderr: string;
  repoBefore: string;
  repoAfterDiff: string;
  repoAfterStatus?: string;
  verification: string;
  todoTransitions: unknown;
  score: unknown;
  contextTrace?: string;
  finalResponse?: string;
}

export function redactSecrets(value: string): string {
  return value
    .replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)(\s*[:=]\s*)(["']?)[^\s,"'}]+\3/gi, "$1$2$3[REDACTED]$3")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, "[REDACTED]");
}

export async function writeArtifactBundle(root: string, runId: string, bundle: ArtifactBundle): Promise<string> {
  const directory = join(root, runId);
  await mkdir(directory, { recursive: true });

  const files: Record<string, string> = {
    "run.json": JSON.stringify(bundle.run, null, 2) + "\n",
    "prompt.txt": bundle.prompt,
    "events.jsonl": bundle.events,
    "session.jsonl": bundle.session,
    "stdout.log": bundle.stdout,
    "stderr.log": bundle.stderr,
    "repo-before.txt": bundle.repoBefore,
    "repo-after.diff": bundle.repoAfterDiff,
    ...(bundle.repoAfterStatus === undefined ? {} : { "repo-after-status.txt": bundle.repoAfterStatus }),
    "verification.log": bundle.verification,
    "todo-transitions.json": JSON.stringify(bundle.todoTransitions, null, 2) + "\n",
    "score.json": JSON.stringify(bundle.score, null, 2) + "\n",
    ...(bundle.contextTrace === undefined ? {} : { "context-trace.jsonl": bundle.contextTrace }),
    ...(bundle.finalResponse === undefined ? {} : { "final-response.txt": bundle.finalResponse }),
  };

  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(directory, name), redactSecrets(content), "utf8");
  }
  return directory;
}
