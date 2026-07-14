import { useState } from "react";
import type { CaptureToggles, MaskRule } from "@orange-replay/shared/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import {
  addAllowedOrigin,
  percentInputToSampleRate,
  retentionInputToDays,
  sampleRateToPercentInput,
  type MaskRuleActionValue,
  type ProjectSettingsDraft,
} from "@/lib/project-settings";
import { AlertCircle, Plus, Trash2, X } from "@/lib/icon-map";
import { CardHeader, NumberWithSuffix, SettingRow, TextInput } from "./settings-fields";

const captureRows: {
  key: keyof CaptureToggles;
  label: string;
  description: string;
}[] = [
  { key: "heatmaps", label: "Heatmaps", description: "Record cursor and click heat cells." },
  { key: "console", label: "Console", description: "Capture browser console events." },
  { key: "network", label: "Network", description: "Capture request timing and status." },
  {
    key: "canvas",
    label: "Canvas",
    description: "Capture canvas pixels at 2 frames per second. Canvas content cannot be masked.",
  },
];

export function CaptureCard({
  capture,
  onToggle,
  retentionDays,
  sampleRate,
  updateDraft,
}: {
  capture: CaptureToggles;
  onToggle: (key: keyof CaptureToggles) => void;
  retentionDays: number;
  sampleRate: number;
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
            value={sampleRateToPercentInput(sampleRate)}
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
            value={String(retentionDays)}
          />
        </SettingRow>
        {captureRows.map((row) => (
          <SettingRow description={row.description} key={row.key} label={row.label}>
            <Switch
              checked={capture[row.key]}
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

export function MaskingCard({
  error,
  maskPolicyVersion,
  onAddRule,
  onRemoveRule,
  onSetAction,
  onSetSelector,
  rules,
}: {
  error: string | null;
  maskPolicyVersion: number;
  onAddRule: () => void;
  onRemoveRule: (index: number) => void;
  onSetAction: (index: number, action: MaskRuleActionValue) => void;
  onSetSelector: (index: number, selector: string) => void;
  rules: readonly MaskRule[];
}) {
  return (
    <section className="lit rounded-lg p-5">
      <CardHeader
        right={
          <Badge color="gray" size="sm">
            policy v{maskPolicyVersion}
          </Badge>
        }
        title="Masking"
        body="Custom rules run after the default input masking policy."
      />
      <div className="mt-4 flex flex-col gap-2">
        {rules.length === 0 ? (
          <div className="rounded-lg border border-dashed border-dash px-4 py-8 text-center text-[13px] text-muted-foreground">
            No custom rules — inputs are masked by default.
          </div>
        ) : (
          maskRuleItems(rules).map(({ key, rule, index }) => (
            <MaskRuleRow
              index={index}
              key={key}
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
            disabled={rules.length >= 200}
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

function maskRuleItems(
  rules: readonly MaskRule[],
): { key: string; rule: MaskRule; index: number }[] {
  const seen = new Map<string, number>();
  return rules.map((rule, index) => {
    const baseKey = `${rule.action}:${rule.selector}`;
    const count = seen.get(baseKey) ?? 0;
    seen.set(baseKey, count + 1);
    return { key: `${baseKey}:${count}`, rule, index };
  });
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

export function OriginsCard({
  origins,
  onRemoveOrigin,
  updateDraft,
}: {
  origins: readonly string[];
  onRemoveOrigin: (origin: string) => void;
  updateDraft: (updater: (currentDraft: ProjectSettingsDraft) => ProjectSettingsDraft) => void;
}) {
  const [input, setInput] = useState("");
  const [error, setError] = useState("");

  function addOrigin(): void {
    const result = addAllowedOrigin(origins, input);
    if (result.error !== null) {
      setError(result.error);
      return;
    }

    setInput("");
    setError("");
    updateDraft((currentDraft) => ({
      ...currentDraft,
      allowedOrigins: result.origins,
    }));
  }

  return (
    <section className="lit rounded-lg p-5">
      <CardHeader
        title="Allowed origins"
        body="Add the sites that can send SDK data to this project."
      />
      {origins.length === 0 && (
        <Alert className="mt-4">
          <AlertCircle aria-hidden />
          <AlertTitle>Recorder is blocked</AlertTitle>
          <AlertDescription>
            Recorder requests are blocked until you add your website origin.
          </AlertDescription>
        </Alert>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {origins.map((origin) => (
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
              onClick={() => {
                setError("");
                onRemoveOrigin(origin);
              }}
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
          onChange={(value) => {
            setInput(value);
            setError("");
          }}
          onEnter={addOrigin}
          placeholder="https://app.example.com"
          value={input}
        />
        <Button leadingIcon={Plus} onClick={addOrigin} size="sm" variant="secondary">
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
