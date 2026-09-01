import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LOCK_STALE_MS = 60_000;
export const LOCK_WAIT_MS = LOCK_STALE_MS + 5_000;
const OWNER_FILE = "owner";

type LockOwner = { pid: number; token: string };

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export function isLockBusyError(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function ownerPath(lockPath: string): string {
  return join(lockPath, OWNER_FILE);
}

function readOwner(lockPath: string): LockOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(ownerPath(lockPath), "utf-8")) as unknown;
    if (!value || typeof value !== "object") return undefined;
    const owner = value as { pid?: unknown; token?: unknown };
    if (typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || typeof owner.token !== "string") {
      return undefined;
    }
    return { pid: owner.pid, token: owner.token };
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but cannot be inspected by this user.
    return errorCode(error) === "EPERM";
  }
}

function releaseLock(lockPath: string, owner: LockOwner) {
  // A stale-lock reclaimer may already have replaced this path with a new
  // owner's lock. Never remove a lock whose token is not ours.
  const current = readOwner(lockPath);
  if (!current || current.pid !== owner.pid || current.token !== owner.token) return;
  try {
    rmSync(lockPath, { recursive: true, force: true });
  } catch {
    // Lock cleanup is best effort; stale-lock recovery handles leftovers.
  }
}

function discardCreatedLock(lockPath: string) {
  try {
    rmSync(lockPath, { recursive: true, force: true });
  } catch {
    // The partially created lock will be recovered by stale-lock handling.
  }
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(() => resolve(true), delayMs));
  }
  if (signal.aborted) return Promise.resolve(false);

  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      resolve(false);
    };
    timer = setTimeout(() => {
      cleanup();
      resolve(true);
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function withDirectoryLock<T>(
  lockPath: string,
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T | undefined> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let locked = false;
  let owner: LockOwner | undefined;

  while (!signal?.aborted && Date.now() < deadline) {
    let createdHere = false;
    try {
      mkdirSync(lockPath);
      createdHere = true;
      owner = { pid: process.pid, token: randomUUID() };
      writeFileSync(ownerPath(lockPath), JSON.stringify(owner), "utf-8");
      locked = true;
      break;
    } catch (error) {
      if (createdHere) {
        discardCreatedLock(lockPath);
        throw error;
      }
      if (!isLockBusyError(error)) throw error;

      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        const currentOwner = readOwner(lockPath);
        if (age > LOCK_STALE_MS && (!currentOwner || !isProcessAlive(currentOwner.pid))) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        // The lock may have been released between mkdir and stat.
      }
      if (!(await waitForRetry(50, signal))) return undefined;
    }
  }

  if (!locked || !owner) return undefined;
  if (signal?.aborted) {
    releaseLock(lockPath, owner);
    return undefined;
  }

  try {
    return await work();
  } finally {
    releaseLock(lockPath, owner);
  }
}
