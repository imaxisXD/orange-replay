import { describe, expect, it } from "vite-plus/test";
import { SessionRecorderStore } from "../src/do/session-recorder-store.ts";

describe("SessionRecorderStore bounded finalization reads", () => {
  it("reads page batches in ordered keyset pages", () => {
    const rows = Array.from({ length: 125 }, (_, index) => ({
      tab: `tab-${String(Math.floor(index / 70)).padStart(2, "0")}`,
      seq: index % 70,
      t0: index,
      t1: index,
      events: JSON.stringify({
        pageAnalyticsVersion: 1,
        events: [],
        url: `/page-${index}`,
      }),
    }));
    const reads: number[] = [];
    const sql = {
      exec: (_query: string, _afterTab: string, afterTabAgain: string, afterSeq: number) => {
        const page = rows
          .filter(
            (row) => row.tab > afterTabAgain || (row.tab === afterTabAgain && row.seq > afterSeq),
          )
          .slice(0, 50);
        reads.push(page.length);
        return { toArray: () => page };
      },
    };
    const store = new SessionRecorderStore(sql as never);

    const batches = store.finalPageBatches();
    expect(reads).toEqual([]);
    expect([...batches]).toHaveLength(125);
    expect(reads).toEqual([50, 50, 25]);
  });

  it("reads only bounded segment references and checkpoint metadata", () => {
    const rows = Array.from({ length: 125 }, (_, index) => ({
      n: index + 1,
      key: `segment-${index + 1}`,
      bytes: 100,
      t0: index,
      t1: index + 1,
      batches: 1,
      has_checkpoint: 1,
      checkpoints: JSON.stringify([{ timestamp: index, tab: "tab-a", batch: 0 }]),
    }));
    const reads: number[] = [];
    const queries: string[] = [];
    const sql = {
      exec: (query: string, afterSegment: number) => {
        queries.push(query);
        if (query.includes("COUNT(*)")) {
          return { one: () => ({ count: rows.length }) };
        }
        const page = rows.filter((row) => row.n > afterSegment).slice(0, 50);
        reads.push(page.length);
        return { toArray: () => page };
      },
    };
    const store = new SessionRecorderStore(sql as never);

    const segments = store.segmentRowsForManifest();
    expect(reads).toEqual([]);
    const storedSegments = [...segments];
    expect(storedSegments).toHaveLength(125);
    expect(storedSegments[0]).toEqual({
      key: "segment-1",
      bytes: 100,
      t0: 0,
      t1: 1,
      batches: 1,
      checkpoints: [{ timestamp: 0, tab: "tab-a", batch: 0 }],
      events: [],
    });
    expect(reads).toEqual([50, 50, 25]);
    expect(
      queries
        .filter((query) => !query.includes("COUNT(*)"))
        .every((query) => query.includes("json_extract(events, '$.checkpoints')")),
    ).toBe(true);
  });

  it("keeps aggregate checkpoints bounded across the largest legal manifest", () => {
    const segmentCount = 10_000;
    const checkpoints = JSON.stringify(
      Array.from({ length: 128 }, (_, index) => ({
        timestamp: index,
        tab: index % 2 === 0 ? "tab-a" : "tab-b",
        batch: index,
      })),
    );
    const sql = {
      exec: (query: string, afterSegment = 0) => {
        if (query.includes("COUNT(*)")) {
          return { one: () => ({ count: segmentCount }) };
        }
        const first = afterSegment + 1;
        const page = Array.from(
          { length: Math.min(50, Math.max(0, segmentCount - afterSegment)) },
          (_, offset) => {
            const n = first + offset;
            return {
              n,
              key: `segment-${n}`,
              bytes: 100,
              t0: n * 128,
              t1: n * 128 + 127,
              batches: 128,
              has_checkpoint: 1,
              checkpoints,
            };
          },
        );
        return { toArray: () => page };
      },
    };
    const store = new SessionRecorderStore(sql as never);
    let totalCheckpoints = 0;
    let firstSegmentCheckpoints = 0;
    let lastSegmentCheckpoints = 0;

    let segmentIndex = 0;
    for (const segment of store.segmentRowsForManifest()) {
      const count = segment.checkpoints?.length ?? 0;
      totalCheckpoints += count;
      if (segmentIndex === 0) firstSegmentCheckpoints = count;
      if (segmentIndex === segmentCount - 1) lastSegmentCheckpoints = count;
      segmentIndex += 1;
    }

    expect(segmentIndex).toBe(segmentCount);
    expect(totalCheckpoints).toBeLessThanOrEqual(2_048);
    expect(firstSegmentCheckpoints).toBeGreaterThan(0);
    expect(lastSegmentCheckpoints).toBeGreaterThan(0);
  });

  it("keeps a sparse checkpoint from an otherwise unselected large segment set", () => {
    const segmentCount = 10_000;
    const checkpointSegment = 4_322;
    const sql = {
      exec: (query: string, afterSegment = 0) => {
        if (query.includes("COUNT(*)")) {
          return {
            one: () => ({
              count: query.includes("WHERE json_type") ? 1 : segmentCount,
            }),
          };
        }
        const first = afterSegment + 1;
        const page = Array.from(
          { length: Math.min(50, Math.max(0, segmentCount - afterSegment)) },
          (_, offset) => {
            const n = first + offset;
            const hasCheckpoint = n === checkpointSegment;
            return {
              n,
              key: `segment-${n}`,
              bytes: 100,
              t0: n * 10,
              t1: n * 10 + 9,
              batches: 1,
              has_checkpoint: hasCheckpoint ? 1 : 0,
              checkpoints: hasCheckpoint
                ? JSON.stringify([{ timestamp: n * 10, tab: "tab-a", batch: 0 }])
                : "[]",
            };
          },
        );
        return { toArray: () => page };
      },
    };
    const store = new SessionRecorderStore(sql as never);
    const kept = [...store.segmentRowsForManifest()].filter(
      (segment) => (segment.checkpoints?.length ?? 0) > 0,
    );

    expect(kept).toEqual([
      {
        key: `segment-${checkpointSegment}`,
        bytes: 100,
        t0: checkpointSegment * 10,
        t1: checkpointSegment * 10 + 9,
        batches: 1,
        checkpoints: [{ timestamp: checkpointSegment * 10, tab: "tab-a", batch: 0 }],
        events: [],
      },
    ]);
  });
});
