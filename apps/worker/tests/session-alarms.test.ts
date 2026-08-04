import { describe, expect, it } from "vite-plus/test";
import { SessionAlarms, type AlarmStorage } from "../src/do/session-alarms.ts";

interface FakeStorage {
  storage: AlarmStorage;
  writes: number[];
  storedAt: () => number | null;
}

function fakeStorage(initialAt: number | null = null): FakeStorage {
  let storedAlarm = initialAt;
  const writes: number[] = [];
  return {
    storage: {
      setAlarm: async (scheduledTime: number | Date) => {
        const at = typeof scheduledTime === "number" ? scheduledTime : scheduledTime.getTime();
        storedAlarm = at;
        writes.push(at);
      },
      getAlarm: async () => storedAlarm,
    } as AlarmStorage,
    writes,
    storedAt: () => storedAlarm,
  };
}

describe("session alarms", () => {
  it("sets the alarm when nothing is pending", async () => {
    const fake = fakeStorage();
    const alarms = new SessionAlarms(fake.storage, () => 1_000);

    await alarms.schedule(5_000, 1_000);

    expect(fake.writes).toEqual([5_000]);
    expect(alarms.pendingAt).toBe(5_000);
  });

  it("skips the billed write while a useful alarm is pending", async () => {
    const fake = fakeStorage();
    const alarms = new SessionAlarms(fake.storage, () => 1_000);

    await alarms.schedule(5_000, 1_000);
    await alarms.schedule(6_000, 1_000);

    expect(fake.writes).toEqual([5_000]);
  });

  it("replaces a pending alarm that already elapsed", async () => {
    const fake = fakeStorage();
    let now = 1_000;
    const alarms = new SessionAlarms(fake.storage, () => now);

    await alarms.schedule(5_000, 1_000);
    now = 5_000;
    await alarms.schedule(9_000, 1_000);

    expect(fake.writes).toEqual([5_000, 9_000]);
  });

  it("pulls in a pending alarm that is far later than desired", async () => {
    const fake = fakeStorage();
    const alarms = new SessionAlarms(fake.storage, () => 1_000);

    await alarms.schedule(10_000, 1_000);
    await alarms.schedule(4_000, 1_000);

    expect(fake.writes).toEqual([10_000, 4_000]);
  });

  it("hydrates the mirror from storage so the gate survives a restart", async () => {
    const fake = fakeStorage(5_000);
    const alarms = new SessionAlarms(fake.storage, () => 1_000);

    await alarms.load();
    await alarms.schedule(6_000, 1_000);

    expect(alarms.pendingAt).toBe(5_000);
    expect(fake.writes).toEqual([]);
  });

  it("schedules again after the alarm fires", async () => {
    const fake = fakeStorage();
    const alarms = new SessionAlarms(fake.storage, () => 1_000);

    await alarms.schedule(5_000, 1_000);
    alarms.onAlarmFired();
    await alarms.schedule(6_000, 1_000);

    expect(fake.writes).toEqual([5_000, 6_000]);
  });

  it("replaces a stale session alarm with the purge", async () => {
    const fake = fakeStorage();
    const alarms = new SessionAlarms(fake.storage, () => 1_000);

    await alarms.schedule(5_000, 1_000);
    await alarms.schedulePurge(1_000_000);

    expect(fake.writes).toEqual([5_000, 1_000_000]);
    expect(fake.storedAt()).toBe(1_000_000);
  });

  it("sets the purge alarm when nothing is pending", async () => {
    const fake = fakeStorage();
    const alarms = new SessionAlarms(fake.storage, () => 1_000);

    await alarms.schedulePurge(1_000_000);

    expect(fake.writes).toEqual([1_000_000]);
    expect(alarms.pendingAt).toBe(1_000_000);
  });

  it("skips the write when the purge is already scheduled", async () => {
    const fake = fakeStorage();
    const alarms = new SessionAlarms(fake.storage, () => 1_000);

    await alarms.schedulePurge(1_000_000);
    await alarms.schedulePurge(1_000_000);

    expect(fake.writes).toEqual([1_000_000]);
  });
});
