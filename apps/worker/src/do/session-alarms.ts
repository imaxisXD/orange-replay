import { shouldSetAlarm } from "./session-timing.ts";

export type AlarmStorage = Pick<DurableObjectStorage, "setAlarm" | "getAlarm">;

/**
 * The one owner of the Durable Object alarm.
 *
 * Every storage.setAlarm write is billed, so every write goes through the
 * shouldSetAlarm gate here, and the in-memory mirror of the pending alarm
 * lives here. Callers cannot reach storage.setAlarm around the gate, and no
 * caller maintains the mirror by hand — the alarm handler reports the firing
 * and this module keeps the mirror true.
 */
export class SessionAlarms {
  private alarmAt: number | null = null;

  constructor(
    private readonly storage: AlarmStorage,
    private readonly now: () => number = Date.now,
  ) {}

  /** Hydrate the mirror from storage. Call once while the DO boots. */
  async load(): Promise<void> {
    this.alarmAt = await this.storage.getAlarm();
  }

  /** The pending alarm time this module believes storage holds. */
  get pendingAt(): number | null {
    return this.alarmAt;
  }

  /**
   * Recover a missing alarm while the Durable Object boots.
   *
   * Never replace an alarm found in storage here. Cloudflare constructs the
   * object before delivering a due alarm, and replacing that alarm in the
   * constructor can restart its retry chain instead of letting the handler run.
   * Normal session work uses schedule(), which can still move a stale future
   * alarm after boot completes.
   */
  async scheduleOnBootIfMissing(desiredAt: number): Promise<void> {
    if (this.alarmAt !== null) {
      return;
    }

    await this.storage.setAlarm(desiredAt);
    this.alarmAt = desiredAt;
  }

  /**
   * Set the alarm toward desiredAt when the gate allows it: nothing pending,
   * the pending alarm already elapsed, or the pending alarm is far later than
   * desired (beyond twice the tail-flush window).
   */
  async schedule(desiredAt: number, flushTailMs: number): Promise<void> {
    if (!shouldSetAlarm({ alarmAt: this.alarmAt, now: this.now(), desiredAt, flushTailMs })) {
      return;
    }

    await this.storage.setAlarm(desiredAt);
    this.alarmAt = desiredAt;
  }

  /**
   * Set the alarm toward the tombstone purge. Finalizing makes any pending
   * session alarm stale — letting it fire would bill a pointless wake-up —
   * so the purge replaces whatever is pending, and only an alarm already
   * targeting this purge skips the write (finalize retries stay free).
   */
  async schedulePurge(purgeAt: number): Promise<void> {
    if (this.alarmAt === purgeAt) {
      return;
    }

    await this.storage.setAlarm(purgeAt);
    this.alarmAt = purgeAt;
  }

  /** The alarm handler consumed the pending alarm; nothing is scheduled. */
  onAlarmFired(): void {
    this.alarmAt = null;
  }
}
