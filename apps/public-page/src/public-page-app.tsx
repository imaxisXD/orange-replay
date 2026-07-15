import type {
  PublicPageBreakdownItem,
  PublicPageData,
  PublicPageRecording,
} from "@orange-replay/shared";
import { useQuery } from "@tanstack/react-query";
import { Suspense, useState, type ComponentType } from "react";
import { publicPageQueryOptions } from "./query.ts";

const numberFormatter = new Intl.NumberFormat("en");
const dateTimeFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export type PublicReplayPlayerComponent = ComponentType<{
  publicId: string;
  recording: PublicPageRecording;
}>;

interface PublicPageAppProperties {
  publicId: string;
  replayPlayer?: PublicReplayPlayerComponent;
}

export function PublicPageApp({ publicId, replayPlayer: ReplayPlayer }: PublicPageAppProperties) {
  const page = useQuery(publicPageQueryOptions(publicId));
  const [selectedRecording, setSelectedRecording] = useState<PublicPageRecording | null>(null);

  if (page.isError || page.data === undefined) {
    return (
      <main className="public-shell public-state" id="main-content">
        <p>{page.isError ? "This public page is no longer available." : "Loading public page…"}</p>
      </main>
    );
  }

  return (
    <main className="public-shell" id="main-content">
      <header className="public-header">
        <a className="brand" href="/" aria-label="Orange Replay home">
          <span className="brand-mark" aria-hidden="true" />
          Orange Replay
        </a>
        <span className="public-label">Public analytics</span>
      </header>

      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">PUBLIC PROJECT OVERVIEW</p>
        <h1 id="page-title">{page.data.projectName}</h1>
        <p className="hero-copy">
          A live view of product usage, with session recordings chosen by the project owner.
        </p>
        <p className="updated">Updated {formatDateTime(page.data.generatedAt)}</p>
      </section>

      <MetricGrid page={page.data} />
      <Breakdowns page={page.data} />

      <section className="recordings-section" aria-labelledby="recordings-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">SELECTED BY THE OWNER</p>
            <h2 id="recordings-title">Session recordings</h2>
          </div>
          <span className="count-pill">{page.data.recordings.length} shared</span>
        </div>

        {page.data.recordings.length === 0 ? (
          <div className="empty-card">No session recordings are shared on this page.</div>
        ) : (
          <div className="recording-list">
            {page.data.recordings.map((recording) => (
              <article className="recording-card" key={recording.replayId}>
                <div>
                  <p className="recording-time">{formatDateTime(recording.startedAt)}</p>
                  <h3>{recording.entryPath}</h3>
                  <p className="recording-meta">
                    {formatDuration(recording.durationMs)} · {recording.device ?? "Unknown device"}
                    {recording.browser ? ` · ${recording.browser}` : ""}
                    {recording.country ? ` · ${recording.country}` : ""}
                  </p>
                </div>
                <div className="recording-numbers" aria-label="Recording summary">
                  <span>{recording.clicks} clicks</span>
                  <span>{recording.pages ?? "—"} pages</span>
                  <span>{recording.rages} rage clicks</span>
                </div>
                <button
                  className="watch-button"
                  type="button"
                  onClick={() => setSelectedRecording(recording)}
                >
                  Watch recording
                </button>
              </article>
            ))}
          </div>
        )}
      </section>

      {selectedRecording !== null && ReplayPlayer !== undefined ? (
        <section className="player-panel" aria-label="Selected session recording">
          <div className="player-heading">
            <div>
              <p className="eyebrow">SESSION REPLAY</p>
              <h2>{selectedRecording.entryPath}</h2>
            </div>
            <button
              className="quiet-button"
              type="button"
              onClick={() => setSelectedRecording(null)}
            >
              Close
            </button>
          </div>
          <Suspense fallback={<div className="player-loading">Loading the replay player…</div>}>
            <ReplayPlayer
              key={`${publicId}:${selectedRecording.replayId}`}
              publicId={publicId}
              recording={selectedRecording}
            />
          </Suspense>
        </section>
      ) : null}

      <footer>Shared with Orange Replay · Analytics refresh while this page is open.</footer>
    </main>
  );
}

function MetricGrid({ page }: { page: PublicPageData }) {
  const metrics = [
    ["Sessions", formatNumber(page.analytics.sessions)],
    ["Average duration", formatDuration(page.analytics.averageDurationMs)],
    ["Median duration", formatDuration(page.analytics.p50DurationMs)],
    ["Total clicks", formatNumber(page.analytics.clicks)],
    ["Pages per session", formatOptionalDecimal(page.analytics.pagesPerSession)],
    ["Sessions with rage clicks", formatPercent(page.analytics.ragePercent)],
  ] as const;

  return (
    <section className="metrics-grid" aria-label="Key metrics">
      {metrics.map(([label, value]) => (
        <article className="metric-card lit" key={label}>
          <p>{label}</p>
          <strong>{value}</strong>
        </article>
      ))}
    </section>
  );
}

function Breakdowns({ page }: { page: PublicPageData }) {
  const breakdowns = [
    ["Countries", page.analytics.countries],
    ["Devices", page.analytics.devices],
    ["Browsers", page.analytics.browsers],
    ["Operating systems", page.analytics.operatingSystems],
    ["Entry pages", page.analytics.entryPages],
  ] as const;

  return (
    <section className="breakdowns" aria-labelledby="breakdowns-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">AUDIENCE AND TRAFFIC</p>
          <h2 id="breakdowns-title">Breakdowns</h2>
        </div>
      </div>
      <div className="breakdown-grid">
        {breakdowns.map(([title, rows]) => (
          <BreakdownCard key={title} title={title} rows={rows} />
        ))}
      </div>
    </section>
  );
}

function BreakdownCard({ title, rows }: { title: string; rows: PublicPageBreakdownItem[] }) {
  return (
    <article className="breakdown-card lit">
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p className="no-data">No data yet</p>
      ) : (
        <ol>
          {rows.map((row) => (
            <li key={row.label}>
              <span className="breakdown-label" title={row.label}>
                {row.label}
              </span>
              <span className="breakdown-bar" aria-hidden="true">
                <span style={{ width: `${Math.max(2, row.share * 100)}%` }} />
              </span>
              <span>{formatPercent(row.share)}</span>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}

function formatNumber(value: number): string {
  return numberFormatter.format(Math.round(value));
}

function formatOptionalDecimal(value: number | null): string {
  return value === null ? "—" : value.toFixed(1);
}

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainingSeconds}s` : `${remainingSeconds}s`;
}

function formatDateTime(timestamp: number): string {
  const value = dateTimeFormatter.format(new Date(timestamp));
  return `${value} UTC`;
}
