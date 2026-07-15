import { MAX_PUBLIC_PAGE_RECORDINGS } from "@orange-replay/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadingArea } from "@/components/ui/loading-indicator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { formatAbsoluteTime, formatDuration } from "@/lib/format";

export interface RecordingChoice {
  sessionId: string;
  startedAt: number;
  durationMs: number;
  entryPath: string;
  country: string | null;
  device: string | null;
  browser: string | null;
}

export function PublishPublicPageDialog({
  error,
  isSaving,
  onOpenChange,
  onPublish,
  open,
}: {
  error: string;
  isSaving: boolean;
  onOpenChange: (open: boolean) => void;
  onPublish: () => void;
  open: boolean;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publish this project page?</DialogTitle>
          <DialogDescription>
            Anyone can view and share its analytics. Search engines may index it. Only the
            recordings shown in your selected list will be included.
          </DialogDescription>
        </DialogHeader>
        {error.length > 0 ? (
          <p className="mt-4 text-[13px] text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="secondary">
            Keep private
          </Button>
          <Button loading={isSaving} onClick={onPublish}>
            Publish page
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PublicRecordingPickerDialog({
  choices,
  error,
  isLoading,
  isSaving,
  loadFailed,
  onClear,
  onOpenChange,
  onSave,
  onToggleRecording,
  open,
  pickerError,
  selectedSessionIds,
}: {
  choices: RecordingChoice[];
  error: string;
  isLoading: boolean;
  isSaving: boolean;
  loadFailed: boolean;
  onClear: () => void;
  onOpenChange: (open: boolean) => void;
  onSave: () => void;
  onToggleRecording: (sessionId: string) => void;
  open: boolean;
  pickerError: string;
  selectedSessionIds: string[];
}) {
  const selectedSessionIdSet = new Set(selectedSessionIds);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-180">
        <DialogHeader>
          <DialogTitle>Choose public recordings</DialogTitle>
          <DialogDescription>
            Select up to {MAX_PUBLIC_PAGE_RECORDINGS} finalized recordings. Their replay content
            will be available without signing in.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 flex items-center justify-between">
          <span className="text-[12px] text-muted-foreground">
            {selectedSessionIds.length}/{MAX_PUBLIC_PAGE_RECORDINGS} selected
          </span>
          <Button
            disabled={selectedSessionIds.length === 0}
            onClick={onClear}
            size="sm"
            variant="ghost"
          >
            Clear
          </Button>
        </div>

        {isLoading ? (
          <LoadingArea className="min-h-72" label="Loading finalized recordings" />
        ) : loadFailed && choices.length === 0 ? (
          <div className="mt-3 rounded-lg border border-danger-border p-4 text-[13px] text-danger">
            Could not load finalized recordings.
          </div>
        ) : choices.length === 0 ? (
          <div className="mt-3 rounded-lg border border-dashed border-dash px-4 py-12 text-center text-[13px] text-muted-foreground">
            No finalized recordings are available yet.
          </div>
        ) : (
          <ScrollArea className="mt-3 h-82 rounded-lg border border-border">
            <div className="divide-y divide-border">
              {choices.map((choice) => (
                <div className="flex items-center gap-3 px-4 py-3" key={choice.sessionId}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-foreground">
                      {choice.entryPath}
                    </p>
                    <p className="mt-1 truncate text-[11.5px] text-dim">
                      {formatAbsoluteTime(choice.startedAt)} · {formatDuration(choice.durationMs)}
                      {choice.device ? ` · ${choice.device}` : ""}
                      {choice.browser ? ` · ${choice.browser}` : ""}
                      {choice.country ? ` · ${choice.country}` : ""}
                    </p>
                  </div>
                  <Switch
                    checked={selectedSessionIdSet.has(choice.sessionId)}
                    className="px-0 py-0 [&>span:last-child]:sr-only"
                    label={`Share recording from ${formatAbsoluteTime(choice.startedAt)}`}
                    onToggle={() => onToggleRecording(choice.sessionId)}
                  />
                </div>
              ))}
            </div>
          </ScrollArea>
        )}

        {pickerError.length > 0 ? (
          <p className="mt-3 text-[13px] text-danger" role="alert">
            {pickerError}
          </p>
        ) : null}
        {error.length > 0 ? (
          <p className="mt-3 text-[13px] text-danger" role="alert">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="secondary">
            Cancel
          </Button>
          <Button loading={isSaving} onClick={onSave}>
            Save recordings
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
