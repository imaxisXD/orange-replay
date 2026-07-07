import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { AlertCircle, KeyRound, Plus, RotateCcw, Server, Trash2, X } from "lucide-react";
import type {
  CaptureToggles,
  MaskRule,
  ProjectKeyAudit,
  ProjectConfigUpdate,
} from "@orange-replay/shared/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputField, InputGroup } from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip } from "@/components/ui/tooltip";
import {
  ApiError,
  fetchProjectConfig,
  fetchProjectKeys,
  getApiToken,
  health,
  saveProjectConfig,
} from "@/lib/api";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/format";
import {
  addAllowedOrigin,
  cleanMaskRules,
  makeProjectSettingsDraft,
  percentInputToSampleRate,
  projectSettingsAreDirty,
  removeAllowedOrigin,
  retentionInputToDays,
  sampleRateToPercentInput,
  updateMaskRules,
  validateMaskRules,
  type MaskRuleActionValue,
  type ProjectSettingsDraft,
} from "@/lib/project-settings";
import { defaultProjectId } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { Elevated } from "@/lib/elevated";
import { useShape } from "@/lib/shape-context";
import { spring } from "@/lib/springs";

type HealthState = "checking" | "connected" | "failed";
type SaveState = "idle" | "saving";

const captureRows: {
  key: keyof CaptureToggles;
  label: string;
  description: string;
}[] = [
  { key: "heatmaps", label: "Heatmaps", description: "Record cursor and click heat cells." },
  { key: "console", label: "Console", description: "Capture browser console events." },
  { key: "network", label: "Network", description: "Capture request timing and status." },
  { key: "canvas", label: "Canvas", description: "Allow canvas snapshots when supported." },
];

export function SettingsPage() {
  const params = useParams({ strict: false });
  const projectId = params.projectId ?? defaultProjectId;
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ProjectSettingsDraft | null>(null);
  const [originInput, setOriginInput] = useState("");
  const [originError, setOriginError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [savedVisible, setSavedVisible] = useState(false);
  const hasToken = getApiToken() !== null;

  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: health,
  });
  const configQuery = useQuery({
    queryKey: ["project-config", projectId],
    queryFn: () => fetchProjectConfig(projectId),
  });
  const keysQuery = useQuery({
    queryKey: ["project-keys", projectId],
    queryFn: () => fetchProjectKeys(projectId),
  });
  const saveMutation = useMutation({
    mutationFn: (update: ProjectConfigUpdate) => saveProjectConfig(projectId, update),
    onSuccess: (savedConfig) => {
      queryClient.setQueryData(["project-config", projectId], savedConfig);
      setDraft(makeProjectSettingsDraft(savedConfig));
      setSavedVisible(true);
    },
    onError: (caughtError) => {
      if (caughtError instanceof ApiError && caughtError.status === 409) {
        void configQuery.refetch();
        setSaveError(
          "Project settings changed elsewhere. Review the latest values and save again.",
        );
        return;
      }
      setSaveError(readErrorMessage(caughtError));
    },
  });

  const config = configQuery.data ?? null;
  const keys = keysQuery.data?.keys ?? [];
  const healthState: HealthState =
    healthQuery.isPending || healthQuery.isFetching
      ? "checking"
      : healthQuery.data?.ok === true
        ? "connected"
        : "failed";
  const error =
    healthQuery.error === null
      ? ""
      : healthQuery.error instanceof Error
        ? healthQuery.error.message
        : "Health check failed.";
  const configLoading = configQuery.isPending;
  const configError = configQuery.error === null ? "" : readErrorMessage(configQuery.error);
  const keysLoading = keysQuery.isPending;
  const keysError = keysQuery.error === null ? "" : readErrorMessage(keysQuery.error);
  const saveState: SaveState = saveMutation.isPending ? "saving" : "idle";

  useEffect(() => {
    if (configQuery.data === undefined) {
      setDraft(null);
      return;
    }
    setDraft(makeProjectSettingsDraft(configQuery.data));
  }, [configQuery.data]);

  useEffect(() => {
    if (!savedVisible) return;
    const timeoutId = window.setTimeout(() => setSavedVisible(false), 2_000);
    return () => window.clearTimeout(timeoutId);
  }, [savedVisible]);

  const maskRulesError = draft === null ? null : validateMaskRules(draft.maskRules);
  const isDirty = config !== null && draft !== null && projectSettingsAreDirty(config, draft);
  const canSave = isDirty && saveState !== "saving" && maskRulesError === null;

  const sortedKeys = useMemo(
    () => [...keys].sort((left, right) => right.created_at - left.created_at),
    [keys],
  );

  function updateDraft(
    updater: (currentDraft: ProjectSettingsDraft) => ProjectSettingsDraft,
  ): void {
    setSaveError("");
    setSavedVisible(false);
    saveMutation.reset();
    setDraft((currentDraft) => (currentDraft === null ? null : updater(currentDraft)));
  }

  function setCaptureToggle(key: keyof CaptureToggles): void {
    updateDraft((currentDraft) => ({
      ...currentDraft,
      capture: {
        ...currentDraft.capture,
        [key]: !currentDraft.capture[key],
      },
    }));
  }

  function setMaskRuleSelector(index: number, selector: string): void {
    updateDraft((currentDraft) => ({
      ...currentDraft,
      maskRules: updateMaskRules(currentDraft.maskRules, { type: "setSelector", index, selector }),
    }));
  }

  function setMaskRuleAction(index: number, action: MaskRuleActionValue): void {
    updateDraft((currentDraft) => ({
      ...currentDraft,
      maskRules: updateMaskRules(currentDraft.maskRules, { type: "setAction", index, action }),
    }));
  }

  function addMaskRule(): void {
    updateDraft((currentDraft) => ({
      ...currentDraft,
      maskRules: updateMaskRules(currentDraft.maskRules, { type: "add" }),
    }));
  }

  function removeMaskRule(index: number): void {
    updateDraft((currentDraft) => ({
      ...currentDraft,
      maskRules: updateMaskRules(currentDraft.maskRules, { type: "remove", index }),
    }));
  }

  function addOrigin(): void {
    if (draft === null) return;
    const result = addAllowedOrigin(draft.allowedOrigins, originInput);
    if (result.error !== null) {
      setOriginError(result.error);
      return;
    }

    setOriginError("");
    setOriginInput("");
    updateDraft((currentDraft) => ({
      ...currentDraft,
      allowedOrigins: result.origins,
    }));
  }

  function removeOrigin(origin: string): void {
    setOriginError("");
    updateDraft((currentDraft) => ({
      ...currentDraft,
      allowedOrigins: removeAllowedOrigin(currentDraft.allowedOrigins, origin),
    }));
  }

  function discardChanges(): void {
    if (config === null) return;
    setDraft(makeProjectSettingsDraft(config));
    setOriginError("");
    setSaveError("");
  }

  function saveChanges(): void {
    if (draft === null || config === null) return;

    const nextMaskRulesError = validateMaskRules(draft.maskRules);
    if (nextMaskRulesError !== null) {
      setSaveError(nextMaskRulesError);
      return;
    }
    if (draft.allowedOrigins.length === 0) {
      setSaveError("Add at least one allowed origin or use * for wildcard access.");
      return;
    }

    setSaveError("");
    saveMutation.mutate({
      expectedVersion: config.version,
      ...draft,
      maskRules: cleanMaskRules(draft.maskRules),
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-[18px] font-semibold tracking-[-0.015em]">
          Settings
          <span className="ml-2.5 text-[12px] font-normal text-dim">
            Project configuration and keys.
          </span>
        </h1>
        <span
          className={cn(
            "transition-opacity duration-200",
            savedVisible ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          <Badge color="green" size="sm" variant="dot">
            Saved
          </Badge>
        </span>
      </div>

      {error.length > 0 && (
        <Alert variant="destructive">
          <Server aria-hidden />
          <AlertTitle>Health check failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {configLoading ? (
        <SettingsLoading />
      ) : configError.length > 0 || draft === null ? (
        <Alert variant="destructive">
          <AlertCircle aria-hidden />
          <AlertTitle>Could not load project settings</AlertTitle>
          <AlertDescription>
            <p>{configError || "Project settings could not be loaded."}</p>
            <Button
              className="mt-2 border-danger-border bg-transparent text-danger-foreground hover:text-foreground"
              leadingIcon={RotateCcw}
              onClick={() => void configQuery.refetch()}
              size="sm"
              variant="secondary"
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <CaptureCard draft={draft} updateDraft={updateDraft} onToggle={setCaptureToggle} />
            <MaskingCard
              draft={draft}
              error={maskRulesError}
              onAddRule={addMaskRule}
              onRemoveRule={removeMaskRule}
              onSetAction={setMaskRuleAction}
              onSetSelector={setMaskRuleSelector}
            />
            <OriginsCard
              draft={draft}
              error={originError}
              input={originInput}
              onAddOrigin={addOrigin}
              onInputChange={(value) => {
                setOriginInput(value);
                setOriginError("");
              }}
              onRemoveOrigin={removeOrigin}
            />
            <KeysCard error={keysError} keys={sortedKeys} loading={keysLoading} />
          </div>

          <AnimatePresence>
            {isDirty && (
              <motion.div
                animate={{ opacity: 1, y: 0 }}
                className="lit sticky bottom-4 z-20 flex flex-col gap-3 rounded-lg p-3 sm:flex-row sm:items-center sm:justify-end"
                exit={{ opacity: 0, y: 8 }}
                initial={{ opacity: 0, y: 8 }}
                transition={spring.moderate}
              >
                <div className="mr-auto text-[12px] text-dim">Unsaved changes</div>
                {(saveError.length > 0 || maskRulesError !== null) && (
                  <div className="text-[12px] text-danger">{saveError || maskRulesError}</div>
                )}
                <Button onClick={discardChanges} size="sm" variant="secondary">
                  Discard
                </Button>
                <Button
                  disabled={!canSave}
                  loading={saveState === "saving"}
                  onClick={saveChanges}
                  size="sm"
                >
                  Save changes
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <section className="lit flex flex-col gap-4 overflow-hidden rounded-lg p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="text-[15px] font-medium">Dev token</h2>
              <p className="text-[13px] text-muted-foreground">Stored in this browser only.</p>
            </div>
            <KeyRound aria-hidden className="size-5 text-muted-foreground" />
          </div>
          <Badge color={hasToken ? "green" : "amber"} size="sm" variant="dot">
            {hasToken ? "Token saved" : "Token missing"}
          </Badge>
        </section>

        <section className="lit flex flex-col gap-4 overflow-hidden rounded-lg p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="text-[15px] font-medium">Worker health</h2>
              <p className="text-[13px] text-muted-foreground">Checks the local API worker.</p>
            </div>
            <Server aria-hidden className="size-5 text-muted-foreground" />
          </div>
          <div className="flex items-center justify-between gap-3">
            <HealthStatus healthState={healthState} />
            <Button
              leadingIcon={RotateCcw}
              loading={healthState === "checking"}
              onClick={() => void healthQuery.refetch()}
              size="sm"
              variant="ghost"
            >
              Check
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}

function CaptureCard({
  draft,
  onToggle,
  updateDraft,
}: {
  draft: ProjectSettingsDraft;
  onToggle: (key: keyof CaptureToggles) => void;
  updateDraft: (updater: (currentDraft: ProjectSettingsDraft) => ProjectSettingsDraft) => void;
}) {
  return (
    <section className="lit rounded-lg p-5">
      <CardHeader title="Capture" body="Control how much session detail the recorder keeps." />
      <div className="mt-4">
        <SettingRow description="Percent of sessions to record." label="Sampling rate">
          <NumberWithSuffix
            ariaLabel="Sampling rate percent"
            max={100}
            min={0}
            onChange={(value) => {
              const sampleRate = percentInputToSampleRate(value);
              if (sampleRate === null) return;
              updateDraft((currentDraft) => ({ ...currentDraft, sampleRate }));
            }}
            suffix="%"
            value={sampleRateToPercentInput(draft.sampleRate)}
          />
        </SettingRow>
        <SettingRow description="Days before recordings expire." label="Retention">
          <NumberWithSuffix
            ariaLabel="Retention days"
            max={365}
            min={1}
            onChange={(value) => {
              const retentionDays = retentionInputToDays(value);
              if (retentionDays === null) return;
              updateDraft((currentDraft) => ({ ...currentDraft, retentionDays }));
            }}
            suffix="days"
            value={String(draft.retentionDays)}
          />
        </SettingRow>
        {captureRows.map((row) => (
          <SettingRow description={row.description} key={row.key} label={row.label}>
            <Switch
              checked={draft.capture[row.key]}
              className="px-0 py-0 [&>span:last-child]:sr-only"
              label={row.label}
              onToggle={() => onToggle(row.key)}
            />
          </SettingRow>
        ))}
      </div>
    </section>
  );
}

function MaskingCard({
  draft,
  error,
  onAddRule,
  onRemoveRule,
  onSetAction,
  onSetSelector,
}: {
  draft: ProjectSettingsDraft;
  error: string | null;
  onAddRule: () => void;
  onRemoveRule: (index: number) => void;
  onSetAction: (index: number, action: MaskRuleActionValue) => void;
  onSetSelector: (index: number, selector: string) => void;
}) {
  return (
    <section className="lit rounded-lg p-5">
      <CardHeader
        right={
          <Badge color="gray" size="sm">
            policy v{draft.maskPolicyVersion}
          </Badge>
        }
        title="Masking"
        body="Custom rules run after the default input masking policy."
      />
      <div className="mt-4 flex flex-col gap-2">
        {draft.maskRules.length === 0 ? (
          <div className="rounded-lg border border-dashed border-dash px-4 py-8 text-center text-[13px] text-muted-foreground">
            No custom rules — inputs are masked by default.
          </div>
        ) : (
          draft.maskRules.map((rule, index) => (
            <MaskRuleRow
              index={index}
              key={index}
              onRemove={() => onRemoveRule(index)}
              onSetAction={(action) => onSetAction(index, action)}
              onSetSelector={(selector) => onSetSelector(index, selector)}
              rule={rule}
            />
          ))
        )}
        {error !== null && <div className="text-[12px] text-danger">{error}</div>}
        <div>
          <Button
            className="mt-1"
            disabled={draft.maskRules.length >= 200}
            leadingIcon={Plus}
            onClick={onAddRule}
            size="sm"
            variant="secondary"
          >
            Add rule
          </Button>
        </div>
      </div>
    </section>
  );
}

function MaskRuleRow({
  index,
  onRemove,
  onSetAction,
  onSetSelector,
  rule,
}: {
  index: number;
  onRemove: () => void;
  onSetAction: (action: MaskRuleActionValue) => void;
  onSetSelector: (selector: string) => void;
  rule: MaskRule;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_112px_32px]">
      <TextInput
        ariaLabel={`Mask rule ${index + 1} selector`}
        mono
        onChange={onSetSelector}
        placeholder=".selector, [attr]"
        value={rule.selector}
      />
      <Select
        onValueChange={(value) => onSetAction(value as MaskRuleActionValue)}
        value={rule.action}
      >
        <SelectTrigger
          aria-label={`Mask rule ${index + 1} action`}
          className="h-8 w-full min-w-0 rounded-[7px] border-border bg-secondary text-[12px]"
        />
        <SelectContent className="rounded-lg border border-border bg-popover">
          <SelectGroup>
            <SelectItem index={0} value="mask">
              mask
            </SelectItem>
            <SelectItem index={1} value="block">
              block
            </SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      <Tooltip content="Remove rule">
        <Button
          aria-label={`Remove mask rule ${index + 1}`}
          className="text-dim hover:text-foreground"
          onClick={onRemove}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <Trash2 aria-hidden />
        </Button>
      </Tooltip>
    </div>
  );
}

function OriginsCard({
  draft,
  error,
  input,
  onAddOrigin,
  onInputChange,
  onRemoveOrigin,
}: {
  draft: ProjectSettingsDraft;
  error: string;
  input: string;
  onAddOrigin: () => void;
  onInputChange: (value: string) => void;
  onRemoveOrigin: (origin: string) => void;
}) {
  return (
    <section className="lit rounded-lg p-5">
      <CardHeader
        title="Allowed origins"
        body="Add the sites that can send SDK data to this project."
      />
      <div className="mt-4 flex flex-wrap gap-2">
        {draft.allowedOrigins.map((origin) => (
          <span
            className="inline-flex items-center gap-2 rounded-full border border-border bg-secondary px-2.25 py-1 text-[11px] text-muted-foreground"
            key={origin}
          >
            <span>{origin}</span>
            <Button
              aria-label={`Remove ${origin}`}
              // size-5 keeps the glyph small; before:-inset-1.5 widens the
              // pointer target to ~32px without overlapping the 8px-gap
              // neighbour chip (a full 40px would collide).
              className="-mr-1 size-5 rounded-full text-dim hover:text-foreground before:-inset-1.5 [&_svg]:size-3"
              onClick={() => onRemoveOrigin(origin)}
              size="icon-sm"
              variant="ghost"
            >
              <X aria-hidden />
            </Button>
          </span>
        ))}
      </div>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <TextInput
          ariaLabel="Allowed origin"
          className="flex-1"
          onChange={onInputChange}
          onEnter={onAddOrigin}
          placeholder="https://app.example.com"
          value={input}
        />
        <Button leadingIcon={Plus} onClick={onAddOrigin} size="sm" variant="secondary">
          Add origin
        </Button>
      </div>
      {error.length > 0 && <div className="mt-2 text-[12px] text-danger">{error}</div>}
      <p className="mt-3 text-[11.5px] text-dim">
        Requests from other origins are rejected at ingest.
      </p>
    </section>
  );
}

function KeysCard({
  error,
  keys,
  loading,
}: {
  error: string;
  keys: ProjectKeyAudit[];
  loading: boolean;
}) {
  const shape = useShape();
  return (
    <section className="lit overflow-hidden rounded-lg p-5">
      <CardHeader
        title="Write keys"
        body="Keys authenticate the SDK's ingest requests. Values are shown only where you created them."
      />
      <div className="mt-4">
        {loading ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 3 }, (_item, index) => (
              <Skeleton className="h-10 w-full rounded-[7px]" key={index} />
            ))}
          </div>
        ) : error.length > 0 ? (
          <div className="rounded-lg border border-dashed border-danger-border px-4 py-6 text-[13px] text-danger-foreground">
            {error}
          </div>
        ) : keys.length === 0 ? (
          <div className="rounded-lg border border-dashed border-dash px-4 py-8 text-center text-[13px] text-muted-foreground">
            No write keys found.
          </div>
        ) : (
          <div className="-mx-5 -mb-5 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Key</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((key, index) => (
                  <TableRow index={index} key={key.key_hash}>
                    <TableCell className="font-mono text-[12px] text-foreground">
                      {key.key_hash.slice(0, 12)}…
                    </TableCell>
                    <TableCell>
                      <Elevated
                        className={cn("inline-flex", shape.item)}
                        offset={4}
                        shadowLevel={4}
                      >
                        <Badge color={key.active ? "green" : "gray"} size="sm" variant="dot">
                          {key.active ? "active" : "revoked"}
                        </Badge>
                      </Elevated>
                    </TableCell>
                    <TableCell
                      className="text-[12px] text-dim"
                      title={formatAbsoluteTime(key.created_at)}
                    >
                      {formatRelativeTime(key.created_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </section>
  );
}

function CardHeader({ body, right, title }: { body: string; right?: ReactNode; title: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-[15px] font-medium">{title}</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">{body}</p>
      </div>
      {right}
    </div>
  );
}

function SettingRow({
  children,
  description,
  label,
}: {
  children: ReactNode;
  description: string;
  label: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-dashed border-dash py-2.25 last:border-b-0">
      <div className="min-w-0">
        <div className="text-[13px] font-medium">{label}</div>
        <div className="mt-0.25 text-[11.5px] text-dim">{description}</div>
      </div>
      <div className="flex-none">{children}</div>
    </div>
  );
}

function NumberWithSuffix({
  ariaLabel,
  max,
  min,
  onChange,
  suffix,
  value,
}: {
  ariaLabel: string;
  max: number;
  min: number;
  onChange: (value: string) => void;
  suffix: string;
  value: string;
}) {
  return (
    <InputGroup className="w-24 gap-0">
      <InputField
        hideLabel
        className="font-mono"
        endContent={<span className="text-[11.5px] text-dim">{suffix}</span>}
        index={0}
        inputMode="decimal"
        label={ariaLabel}
        max={max}
        min={min}
        onChange={onChange}
        style={{ textAlign: "right" }}
        type="number"
        value={value}
      />
    </InputGroup>
  );
}

function TextInput({
  ariaLabel,
  className,
  mono = false,
  onChange,
  onEnter,
  placeholder,
  value,
}: {
  ariaLabel: string;
  className?: string;
  mono?: boolean;
  onChange: (value: string) => void;
  onEnter?: () => void;
  placeholder: string;
  value: string;
}) {
  return (
    <InputGroup className={cn("w-full gap-0", className)}>
      <InputField
        hideLabel
        className={cn(mono && "font-mono")}
        index={0}
        label={ariaLabel}
        onChange={onChange}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          onEnter?.();
        }}
        placeholder={placeholder}
        value={value}
      />
    </InputGroup>
  );
}

function SettingsLoading() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {Array.from({ length: 4 }, (_item, index) => (
        <section className="lit rounded-lg p-5" key={index}>
          <Skeleton className="h-5 w-32" />
          <Skeleton className="mt-2 h-4 w-64 max-w-full" />
          <div className="mt-5 flex flex-col gap-3">
            <Skeleton className="h-10 w-full rounded-[7px]" />
            <Skeleton className="h-10 w-full rounded-[7px]" />
            <Skeleton className="h-10 w-full rounded-[7px]" />
          </div>
        </section>
      ))}
    </div>
  );
}

function HealthStatus({ healthState }: { healthState: HealthState }) {
  if (healthState === "connected") {
    return (
      <Badge color="green" size="sm" variant="dot">
        Connected
      </Badge>
    );
  }

  if (healthState === "failed") {
    return (
      <Badge color="red" size="sm" variant="dot">
        Failed
      </Badge>
    );
  }

  return (
    <Badge color="gray" size="sm" variant="dot">
      Checking
    </Badge>
  );
}

function readErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.code ?? error.message;
  if (error instanceof Error) return error.message;
  return "The API request failed.";
}
