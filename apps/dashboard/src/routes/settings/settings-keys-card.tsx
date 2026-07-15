import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { InputField, InputGroup } from "@/components/ui/input-group";
import { LoadingArea } from "@/components/ui/loading-indicator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ApiError,
  createProjectKey,
  fetchProjectKeys,
  revokeProjectKey,
  type CreatedProjectKeyResponse,
  type ProjectKeyAudit,
} from "@/lib/api";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/format";
import { Check, Copy, KeyRound, Plus, Trash2 } from "@/lib/icon-map";
import { useShape } from "@/lib/shape-context";
import { cn } from "@/lib/utils";
import { CardHeader } from "./settings-fields";

export function KeysCard({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const shape = useShape();
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState("");
  const [createdKey, setCreatedKey] = useState<CreatedProjectKeyResponse | null>(null);
  const [keyToRevoke, setKeyToRevoke] = useState<ProjectKeyAudit | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const keysQuery = useQuery({
    queryKey: ["project-keys", projectId],
    queryFn: () => fetchProjectKeys(projectId),
  });
  const keys = (keysQuery.data?.keys ?? []).toSorted(
    (left, right) => right.createdAt - left.createdAt,
  );
  const createKeyMutation = useMutation({
    mutationFn: (keyName: string) => createProjectKey(projectId, keyName),
    onSuccess: (result) => {
      setName("");
      setCreatedKey(result);
      setCopied(false);
      void queryClient.invalidateQueries({ queryKey: ["project-keys", projectId] });
    },
  });
  const revokeKeyMutation = useMutation({
    mutationFn: (keyId: string) => revokeProjectKey(projectId, keyId),
    onSuccess: () => {
      setKeyToRevoke(null);
      void queryClient.invalidateQueries({ queryKey: ["project-keys", projectId] });
    },
  });
  const loading = keysQuery.isPending;
  const loadError = readKeyError(keysQuery.error, "Could not load write keys.");
  const createError = readKeyError(createKeyMutation.error, "Could not create the write key.");
  const revokeError = readKeyError(revokeKeyMutation.error, "Could not revoke the write key.");

  function submitNewKey(): void {
    const cleanName = name.trim();
    if (cleanName.length === 0) {
      setNameError("Enter a name for this key.");
      return;
    }
    if (cleanName.length > 64) {
      setNameError("Keep the key name under 65 characters.");
      return;
    }
    setNameError("");
    createKeyMutation.mutate(cleanName);
  }

  async function copySecret(): Promise<boolean> {
    if (createdKey === null) return false;
    try {
      await window.navigator.clipboard.writeText(createdKey.secret);
      setCopied(true);
      setCopyError("");
      return true;
    } catch {
      setCopyError("Could not copy the key. Select it and copy it manually.");
      return false;
    }
  }

  async function copyAndOpenInstall(): Promise<void> {
    const didCopy = await copySecret();
    if (!didCopy) return;
    setCreatedKey(null);
    createKeyMutation.reset();
    void navigate({
      to: "/projects/$projectId/install",
      params: { projectId },
    });
  }

  return (
    <section className="lit overflow-hidden rounded-lg p-5">
      <CardHeader
        title="Write keys"
        body="Keys connect the recorder to this project. A new secret is shown only once."
      />

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <InputGroup className="w-full flex-1">
          <InputField
            autoComplete="off"
            disabled={createKeyMutation.isPending}
            error={nameError}
            icon={KeyRound}
            index={0}
            label="Key name"
            onChange={(value) => {
              setName(value);
              setNameError("");
              createKeyMutation.reset();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submitNewKey();
              }
            }}
            placeholder="Production website"
            value={name}
          />
        </InputGroup>
        <Button leadingIcon={Plus} loading={createKeyMutation.isPending} onClick={submitNewKey}>
          Create key
        </Button>
      </div>

      {createError.length > 0 && (
        <p className="mt-3 text-[13px] text-danger" role="alert">
          {createError}
        </p>
      )}

      <div className="mt-4">
        {loading ? (
          <LoadingArea
            className="min-h-32 rounded-lg border border-dashed border-dash"
            label="Loading write keys"
          />
        ) : loadError.length > 0 ? (
          <Empty className="border border-danger-border py-8">
            <EmptyHeader>
              <EmptyTitle>Could not load write keys</EmptyTitle>
              <EmptyDescription>{loadError}</EmptyDescription>
            </EmptyHeader>
            <Button onClick={() => void keysQuery.refetch()} size="sm" variant="secondary">
              Retry
            </Button>
          </Empty>
        ) : keys.length === 0 ? (
          <Empty className="border border-dash py-8">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <KeyRound aria-hidden />
              </EmptyMedia>
              <EmptyTitle>No write keys yet</EmptyTitle>
              <EmptyDescription>Name the first key above to connect your website.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="-mx-5 -mb-5 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((key, index) => (
                  <TableRow index={index} key={key.id}>
                    <TableCell className="text-[13px] font-medium text-foreground">
                      {key.name}
                    </TableCell>
                    <TableCell className="font-mono text-[12px] text-muted-foreground">
                      {key.keyHashPrefix}…
                    </TableCell>
                    <TableCell>
                      <div className={cn("inline-flex bg-surface-5 shadow-surface-4", shape.item)}>
                        <Badge color={key.active ? "green" : "gray"} size="sm" variant="dot">
                          {key.active ? "Active" : "Revoked"}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell
                      className="text-[12px] text-muted-foreground"
                      title={formatAbsoluteTime(key.createdAt)}
                    >
                      {formatRelativeTime(key.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        className="text-danger-foreground hover:text-foreground"
                        disabled={!key.active}
                        leadingIcon={Trash2}
                        onClick={() => {
                          revokeKeyMutation.reset();
                          setKeyToRevoke(key);
                        }}
                        size="sm"
                        variant="ghost"
                      >
                        Revoke
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setCreatedKey(null);
            setCopied(false);
            setCopyError("");
            createKeyMutation.reset();
          }
        }}
        open={createdKey !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save this write key now</DialogTitle>
            <DialogDescription>
              This secret is shown once. Orange Replay stores only its secure hash.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-5 rounded-lg border border-dashed border-amber/35 bg-secondary p-4">
            <p className="text-[11px] uppercase tracking-[0.06em] text-dim">
              {createdKey?.key.name ?? "New write key"}
            </p>
            <textarea
              aria-label="New write key secret"
              className="mt-2 block min-h-16 w-full resize-none bg-transparent font-mono text-base leading-relaxed text-foreground outline-none focus-visible:ring-1 focus-visible:ring-amber sm:text-[12px]"
              onFocus={(event) => event.currentTarget.select()}
              readOnly
              rows={3}
              spellCheck={false}
              value={createdKey?.secret ?? ""}
            />
          </div>
          {copyError.length > 0 && (
            <p className="mt-3 text-[13px] text-danger" role="alert">
              {copyError}
            </p>
          )}
          <DialogFooter>
            <Button
              leadingIcon={copied ? Check : Copy}
              onClick={() => void copySecret()}
              variant="secondary"
            >
              {copied ? "Copied" : "Copy key"}
            </Button>
            <Button onClick={() => void copyAndOpenInstall()}>Copy and open Install</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setKeyToRevoke(null);
            revokeKeyMutation.reset();
          }
        }}
        open={keyToRevoke !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke {keyToRevoke?.name}?</DialogTitle>
            <DialogDescription>
              The recorder will stop accepting this key. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {revokeError.length > 0 && (
            <p className="mt-4 text-[13px] text-danger" role="alert">
              {revokeError}
            </p>
          )}
          <DialogFooter>
            <Button onClick={() => setKeyToRevoke(null)} variant="secondary">
              Keep key
            </Button>
            <Button
              className="border border-danger-border bg-danger-surface text-danger-foreground"
              loading={revokeKeyMutation.isPending}
              onClick={() => {
                if (keyToRevoke !== null) revokeKeyMutation.mutate(keyToRevoke.id);
              }}
            >
              Revoke key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function readKeyError(error: unknown, fallback: string): string {
  if (error === null || error === undefined) return "";
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : fallback;

  switch (error.code) {
    case "active_key_limit_reached":
      return "This project already has the maximum of 10 active keys.";
    case "key_history_limit_reached":
      return "This project has 100 recent key records. Revoked records are removed after 90 days.";
    case "invalid_key_name":
      return "Use a clear key name between 1 and 64 characters.";
    case "key_cache_unavailable":
      return "The key store is unavailable. Try again in a moment.";
    case "key_not_found":
      return "This key no longer exists. Refresh the list.";
    case "key_was_revoked":
      return "The key was revoked while it was being created. Create a new key.";
    case "rate_limited":
      return "Too many key changes. Wait a minute and try again.";
    case "forbidden":
      return "Only a workspace owner or admin can manage keys.";
    default:
      return fallback;
  }
}
