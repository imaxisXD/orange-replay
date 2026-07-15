import { MAX_PUBLIC_PAGE_RECORDINGS } from "@orange-replay/shared";
import type { PublicPageSelectedRecording } from "@orange-replay/shared/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AnimatedNumber } from "@/components/animated-number";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingArea } from "@/components/ui/loading-indicator";
import { Switch } from "@/components/ui/switch";
import {
  ApiError,
  fetchPublicPageSettings,
  listSessions,
  savePublicPageSettings,
  type SessionListItem,
} from "@/lib/api";
import { ArrowUpRight, Check, Copy, Eye, Info } from "@/lib/icon-map";
import { CardHeader } from "./settings-fields";
import {
  PublishPublicPageDialog,
  PublicRecordingPickerDialog,
  type RecordingChoice,
} from "./settings-public-page-dialogs";

const publicPageQueryKey = (projectId: string) => ["public-page-settings", projectId] as const;

export function PublicPageCard({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [publishConfirmationOpen, setPublishConfirmationOpen] = useState(false);
  const [recordingPickerOpen, setRecordingPickerOpen] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [pickerError, setPickerError] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const settingsQuery = useQuery({
    queryKey: publicPageQueryKey(projectId),
    queryFn: () => fetchPublicPageSettings(projectId),
  });
  const sessionsQuery = useQuery({
    queryKey: ["public-page-recording-options", projectId],
    queryFn: ({ signal }) => listSessions(projectId, { limit: 100, sort: "newest" }, { signal }),
    enabled: recordingPickerOpen,
  });
  const saveMutation = useMutation({
    mutationFn: (update: { enabled: boolean; sessionIds: string[] }) =>
      savePublicPageSettings(projectId, update),
    onSuccess: (settings) => {
      queryClient.setQueryData(publicPageQueryKey(projectId), settings);
      setSelectedSessionIds(settings.recordings.map((recording) => recording.sessionId));
      setPublishConfirmationOpen(false);
      setRecordingPickerOpen(false);
      setPickerError("");
    },
  });
  const settings = settingsQuery.data;
  const choices = mergeRecordingChoices(
    sessionsQuery.data?.sessions ?? [],
    settings?.recordings ?? [],
  );
  const loadError = publicPageError(settingsQuery.error, "Could not load public page settings.");
  const saveError = publicPageError(saveMutation.error, "Could not save public page settings.");

  function saveEnabled(enabled: boolean): void {
    if (settings === undefined) return;
    saveMutation.reset();
    saveMutation.mutate({
      enabled,
      sessionIds: settings.recordings.map((recording) => recording.sessionId),
    });
  }

  function openRecordingPicker(): void {
    if (settings === undefined) return;
    setSelectedSessionIds(settings.recordings.map((recording) => recording.sessionId));
    setPickerError("");
    saveMutation.reset();
    setRecordingPickerOpen(true);
  }

  function toggleRecording(sessionId: string): void {
    if (selectedSessionIds.includes(sessionId)) {
      setPickerError("");
      setSelectedSessionIds(selectedSessionIds.filter((value) => value !== sessionId));
      return;
    }
    if (selectedSessionIds.length >= MAX_PUBLIC_PAGE_RECORDINGS) {
      setPickerError(`You can share up to ${MAX_PUBLIC_PAGE_RECORDINGS} recordings.`);
      return;
    }
    setPickerError("");
    setSelectedSessionIds([...selectedSessionIds, sessionId]);
  }

  async function copyPublicUrl(): Promise<void> {
    if (settings?.publicUrl === null || settings?.publicUrl === undefined) return;
    try {
      await window.navigator.clipboard.writeText(settings.publicUrl);
      setCopied(true);
      setCopyError("");
    } catch {
      setCopyError("Could not copy the address. Select it and copy it manually.");
    }
  }

  function openPublicPage(): void {
    if (!settings?.enabled || settings.publicUrl === null) return;
    window.open(settings.publicUrl, "_blank", "noopener,noreferrer");
  }

  return (
    <section className="lit rounded-lg p-5 md:col-span-2">
      <CardHeader
        right={
          <Badge color={settings?.enabled ? "green" : "gray"} size="sm" variant="dot">
            {settings?.enabled ? "Published" : "Private"}
          </Badge>
        }
        title="Public page"
        body="Publish safe project analytics and up to ten recordings that you choose."
      />

      {settingsQuery.isPending ? (
        <LoadingArea
          className="mt-4 min-h-36 rounded-lg border border-dashed border-dash"
          label="Loading public page settings"
        />
      ) : loadError.length > 0 || settings === undefined ? (
        <div className="mt-4 rounded-lg border border-danger-border p-4">
          <p className="text-[13px] text-danger" role="alert">
            {loadError || "Could not load public page settings."}
          </p>
          <Button
            className="mt-3"
            onClick={() => void settingsQuery.refetch()}
            size="sm"
            variant="secondary"
          >
            Retry
          </Button>
        </div>
      ) : (
        <>
          <Alert className="mt-4">
            <Info aria-hidden />
            <AlertTitle>Anyone with the address can view it</AlertTitle>
            <AlertDescription>
              Published analytics can be indexed by search engines. Only recordings you select are
              shared, and live sessions are never included.
            </AlertDescription>
          </Alert>

          <div className="mt-4 divide-y divide-border rounded-lg border border-border bg-secondary/45">
            <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-[13px] font-medium text-foreground">Publish this page</p>
                <p className="mt-1 text-[12px] text-muted-foreground">
                  Turning this off blocks the page and its recordings on the next request. Search
                  results may take time to disappear.
                </p>
              </div>
              <Switch
                checked={settings.enabled}
                className="px-0 py-0 [&>span:last-child]:sr-only"
                disabled={saveMutation.isPending}
                label="Publish public page"
                onToggle={() => {
                  if (settings.enabled) saveEnabled(false);
                  else setPublishConfirmationOpen(true);
                }}
              />
            </div>

            <div className="p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] text-dim">Public address</p>
                  {settings.publicUrl === null ? (
                    <p className="mt-1 text-[13px] text-muted-foreground">
                      An address is created when you first save or publish.
                    </p>
                  ) : (
                    <input
                      aria-label="Public page address"
                      className="mt-1 h-8 w-full rounded-[7px] border border-border bg-background px-2.5 font-mono text-base text-foreground outline-none focus-visible:ring-1 focus-visible:ring-amber sm:text-[12px]"
                      onFocus={(event) => event.currentTarget.select()}
                      readOnly
                      value={settings.publicUrl}
                    />
                  )}
                </div>
                <div className="flex gap-2">
                  <Button
                    disabled={settings.publicUrl === null}
                    leadingIcon={copied ? Check : Copy}
                    onClick={() => void copyPublicUrl()}
                    size="sm"
                    variant="secondary"
                  >
                    {copied ? "Copied" : "Copy"}
                  </Button>
                  <Button
                    disabled={!settings.enabled || settings.publicUrl === null}
                    leadingIcon={ArrowUpRight}
                    onClick={openPublicPage}
                    size="sm"
                    variant="secondary"
                  >
                    Open
                  </Button>
                </div>
              </div>
              {copyError.length > 0 ? (
                <p className="mt-2 text-[12px] text-danger" role="alert">
                  {copyError}
                </p>
              ) : null}
            </div>

            <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-[13px] font-medium text-foreground">Shared recordings</p>
                <p className="mt-1 text-[12px] text-muted-foreground">
                  <AnimatedNumber value={settings.recordings.length} />/{MAX_PUBLIC_PAGE_RECORDINGS}{" "}
                  finalized recordings selected. Analytics can be public with none selected.
                </p>
              </div>
              <Button leadingIcon={Eye} onClick={openRecordingPicker} size="sm" variant="secondary">
                Choose recordings
              </Button>
            </div>
          </div>

          {saveError.length > 0 ? (
            <p className="mt-3 text-[13px] text-danger" role="alert">
              {saveError}
            </p>
          ) : null}
        </>
      )}

      <PublishPublicPageDialog
        error={saveError}
        isSaving={saveMutation.isPending}
        onOpenChange={setPublishConfirmationOpen}
        onPublish={() => saveEnabled(true)}
        open={publishConfirmationOpen}
      />

      <PublicRecordingPickerDialog
        choices={choices}
        error={saveError}
        isLoading={sessionsQuery.isPending}
        isSaving={saveMutation.isPending}
        loadFailed={sessionsQuery.isError}
        onOpenChange={(open) => {
          setRecordingPickerOpen(open);
          if (!open) setPickerError("");
        }}
        onClear={() => {
          setSelectedSessionIds([]);
          setPickerError("");
        }}
        onSave={() =>
          saveMutation.mutate({
            enabled: settings?.enabled ?? false,
            sessionIds: selectedSessionIds,
          })
        }
        onToggleRecording={toggleRecording}
        open={recordingPickerOpen}
        pickerError={pickerError}
        selectedSessionIds={selectedSessionIds}
      />
    </section>
  );
}

function mergeRecordingChoices(
  sessions: SessionListItem[],
  selected: PublicPageSelectedRecording[],
): RecordingChoice[] {
  const choices = sessions.map(sessionToChoice);
  const knownIds = new Set(choices.map((choice) => choice.sessionId));
  for (const recording of selected) {
    if (knownIds.has(recording.sessionId)) continue;
    choices.push({
      sessionId: recording.sessionId,
      startedAt: recording.startedAt,
      durationMs: recording.durationMs,
      entryPath: recording.entryPath,
      country: recording.country,
      device: recording.device,
      browser: recording.browser,
    });
  }
  return choices.toSorted((left, right) => right.startedAt - left.startedAt);
}

function sessionToChoice(session: SessionListItem): RecordingChoice {
  return {
    sessionId: session.session_id,
    startedAt: session.started_at,
    durationMs: session.duration_ms,
    entryPath: safeEntryPath(session.entry_url),
    country: session.country,
    device: session.device,
    browser: session.browser,
  };
}

function safeEntryPath(value: string | null): string {
  if (!value) return "/";
  try {
    return new URL(value, "https://dashboard.invalid").pathname || "/";
  } catch {
    return "/";
  }
}

function publicPageError(error: unknown, fallback: string): string {
  if (error === null || error === undefined) return "";
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : fallback;
  if (error.code === "public_page_origin_not_set") {
    return "The public page address is not set on the Worker.";
  }
  if (error.code === "public_page_origin_invalid") {
    return "The public page address on the Worker is invalid.";
  }
  if (error.code === "recording_not_available") {
    return "One selected recording is no longer available. Reload and choose again.";
  }
  return fallback;
}
