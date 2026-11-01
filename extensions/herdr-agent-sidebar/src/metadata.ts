import { execFile } from "node:child_process";

const SOURCE = "pi-completion-time";
const LIFECYCLE_SOURCE = "herdr:pi";

export type HerdrTarget = {
  binaryPath: string;
  paneId: string;
};

/** Serializes this extension's writes so shutdown cleanup is always the last one. */
export class HerdrMetadataReporter {
  private pending: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly target: HerdrTarget;

  constructor(target: HerdrTarget) {
    this.target = target;
  }

  report(...options: string[]): Promise<void> {
    if (this.closed) return this.pending;
    return this.enqueue(options);
  }

  close(): Promise<void> {
    if (this.closed) return this.pending;
    this.closed = true;
    return this.enqueue(["--clear-state-labels"]);
  }

  private enqueue(options: string[]): Promise<void> {
    this.pending = this.pending
      .then(() => new Promise<void>((resolve, reject) => {
        execFile(
          this.target.binaryPath,
          [
            "pane", "report-metadata", this.target.paneId,
            "--source", SOURCE,
            "--agent", "pi",
            "--applies-to-source", LIFECYCLE_SOURCE,
            ...options,
          ],
          { windowsHide: true, timeout: 5_000 },
          (error) => error ? reject(error) : resolve(),
        );
      }))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[herdr-agent-sidebar] metadata update failed: ${message}`);
      });
    return this.pending;
  }
}
