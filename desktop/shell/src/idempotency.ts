/**
 * Publish idempotency ledger.
 *
 * `idempotencyKey` is derived from the draft id plus its approval timestamp,
 * so the same approved draft always produces the same key. Two things are
 * guarded here:
 *
 *  - a retry after a network stall must not post twice;
 *  - an attempt whose result could not be confirmed must *stay* unconfirmed.
 *    Reporting "not sent" for a post that may well have gone out, and then
 *    letting a retry send it again, is the one failure mode worse than an
 *    error message.
 *
 * Only terminal results are remembered. "Not signed in" is not terminal: the
 * operator signs in and the same approved draft is meant to go out.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PublishOutcome } from "./session-bridge-server";

export type LedgerEntry = {
  outcome: PublishOutcome;
  draftId: string;
  platform: string;
  recordedAt: string;
};

type LedgerFile = { version: 1; entries: Record<string, LedgerEntry> };

function emptyFile(): LedgerFile {
  return { version: 1, entries: {} };
}

export class IdempotencyLedger {
  private readonly filePath: string;
  private file: LedgerFile;
  private readonly inFlight = new Map<string, Promise<PublishOutcome>>();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.file = this.read();
  }

  private read(): LedgerFile {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as LedgerFile;
      if (parsed && typeof parsed === "object" && parsed.entries) return parsed;
      return emptyFile();
    } catch {
      return emptyFile();
    }
  }

  private write(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(this.file, null, 2)}\n`, "utf8");
  }

  get(key: string): LedgerEntry | null {
    return this.file.entries[key] ?? null;
  }

  record(key: string, entry: Omit<LedgerEntry, "recordedAt">): void {
    this.file.entries[key] = { ...entry, recordedAt: new Date().toISOString() };
    this.write();
  }

  /**
   * Runs `attempt` unless this key already has a terminal result, in which
   * case the recorded result is replayed. Concurrent callers with the same key
   * share one attempt.
   */
  async run(
    key: string,
    context: { draftId: string; platform: string },
    attempt: () => Promise<PublishOutcome>,
  ): Promise<PublishOutcome> {
    const recorded = this.get(key);
    if (recorded) return recorded.outcome;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const running = (async () => {
      const outcome = await attempt();
      if (isTerminal(outcome)) {
        this.record(key, { outcome, draftId: context.draftId, platform: context.platform });
      }
      return outcome;
    })().finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, running);
    return running;
  }
}

/**
 * Terminal means "never attempt this key again": it either reached the
 * platform, or we cannot prove that it did not.
 */
export function isTerminal(outcome: PublishOutcome): boolean {
  if (outcome.kind === "published") return true;
  if (outcome.kind === "rejected") return outcome.status === 409;
  return false;
}

/**
 * The result for an attempt that was submitted but whose confirmation never
 * arrived. 409 marks it terminal: a retry replays this same answer instead of
 * risking a duplicate post.
 */
export function unconfirmedOutcome(detail: string): PublishOutcome {
  return { kind: "rejected", detail, status: 409 };
}
