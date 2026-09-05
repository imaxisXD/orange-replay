import { useState } from "react";
import type { CaptureToggles } from "@orange-replay/shared/types";
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
import { NumberStepper } from "@/components/number-stepper";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import {
  addAllowedOrigin,
  percentInputToSampleRate,
  sampleRateToPercentInput,
  type MaskRuleActionValue,
  type DraftMaskRule,
  type ProjectSettingsDraft,
} from "@/lib/project-settings";
import { AlertCircle, Plus, Trash2, X } from "@/lib/icon-map";
import { AnimatePresence, m, useReducedMotion } from "@/lib/motion";
import { spring } from "@/lib/springs";
import { SettingRow, SettingsCard, TextInput } from "./settings-fields";

const captureRows: {
  key: keyof CaptureToggles;
  label: string;
  description: string;
}[] = [
  {
    key: "heatmaps",
    label: "Record heatmap data",
    description: "Capture cursor and click locations.",
  },
  {
    key: "console",
    label: "Capture console events",
    description: "Capture browser console events.",
  },
  {
    key: "network",
    label: "Capture network details",
    description: "Capture request timing and status.",
  },
  {
    key: "canvas",
    label: "Capture canvas pixels",
    description: "Capture canvas pixels at 2 frames per second. Canvas content cannot be masked.",
  },
];

export function CaptureCard({
  capture,
  error,
  onToggle,
  replayAssets,
  retentionDays,
  sampleRate,
  updateDraft,
}: {
  capture: CaptureToggles;
  error: string;
  onToggle: (key: keyof CaptureToggles) => void;
  replayAssets: boolean;
  retentionDays: number;
  sampleRate: number;
  updateDraft: (updater: (currentDraft: ProjectSettingsDraft) => ProjectSettingsDraft) => void;
}) {
  return (
    <SettingsCard body="Control recording detail. Analytics are kept for 2 years." title="Capture">
      <>
        <SettingRow description="Percent of sessions to record." label="Sampling rate">
          <NumberStepper
            ariaLabel="Sampling rate percent"
            max={100}
            min={0}
            onChange={(percent) => {
              const nextSampleRate = percentInputToSampleRate(String(percent));
              if (nextSampleRate === null) return;
              updateDraft((currentDraft) => ({ ...currentDraft, sampleRate: nextSampleRate }));
            }}
            suffix="%"
            value={Number(sampleRateToPercentInput(sampleRate))}
          />
        </SettingRow>
        <SettingRow description="Days recordings remain playable." label="Recording retention">
          <NumberStepper
            ariaLabel="Retention days"
            max={365}
            min={1}
            onChange={(retentionDays) =>
              updateDraft((currentDraft) => ({ ...currentDraft, retentionDays }))
            }
            suffix={retentionDays === 1 ? "day" : "days"}
            value={retentionDays}
          />
        </SettingRow>
        <Switch
          checked={replayAssets}
          className="px-4 py-3.5"
          description="Privately cache public styles, fonts, and background images after recording."
          label="Preserve replay styling"
          labelFirst
          onToggle={() =>
            updateDraft((currentDraft) => ({
              ...currentDraft,
              replayAssets: !currentDraft.replayAssets,
            }))
          }
        />
        {/* The switch owns the whole row rather than sitting inside a SettingRow:
            its title and description are the toggle's own label, so clicking or
            hovering the text works the control like the filter toggles do. */}
        {captureRows.map((row) => (
          <Switch
            checked={capture[row.key]}
            className="px-4 py-3.5"
            description={row.description}
            key={row.key}
            label={row.label}
            labelFirst
            onToggle={() => onToggle(row.key)}
          />
        ))}
        {error.length > 0 && <div className="px-4 py-3 text-[12px] text-danger">{error}</div>}
      </>
    </SettingsCard>
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
  rules: readonly DraftMaskRule[];
}) {
  const reduceMotion = useReducedMotion();

  return (
    <SettingsCard
      body="Input values are masked by default. Page text is masked only where selected rules apply. Changes apply when a page starts recording again; existing recordings keep their captured content."
      className="flex flex-col gap-2 p-4"
      right={
        <Badge color="gray" size="sm">
          policy v{maskPolicyVersion}
        </Badge>
      }
      title="Masking"
    >
      <>
        <AnimatePresence initial={false} mode="popLayout">
          {rules.length === 0 ? (
            <m.div
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              initial={reduceMotion ? false : { opacity: 0 }}
              key="empty"
              transition={reduceMotion ? { duration: 0 } : spring.fast}
            >
              <div className="rounded-lg border border-dashed border-dash px-4 py-8 text-center text-[13px] text-muted-foreground">
                No custom rules. Inputs are masked by default.
              </div>
            </m.div>
          ) : (
            rules.map((rule, index) => (
              <m.div
                animate={{ opacity: 1, transform: "translateY(0px) scale(1)" }}
                exit={
                  reduceMotion
                    ? { opacity: 0, pointerEvents: "none" }
                    : {
                        opacity: 0,
                        pointerEvents: "none",
                        transform: "translateY(-4px) scale(0.98)",
                      }
                }
                initial={
                  reduceMotion ? false : { opacity: 0, transform: "translateY(-4px) scale(0.98)" }
                }
                key={rule.uiId}
                layout
                transition={reduceMotion ? { duration: 0 } : spring.moderate}
              >
                <MaskRuleRow
                  index={index}
                  onRemove={() => onRemoveRule(index)}
                  onSetAction={(action) => onSetAction(index, action)}
                  onSetSelector={(selector) => onSetSelector(index, selector)}
                  rule={rule}
                />
              </m.div>
            ))
          )}
        </AnimatePresence>
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
      </>
    </SettingsCard>
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
  rule: DraftMaskRule;
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
  error: saveError,
  origins,
  onRemoveOrigin,
  updateDraft,
}: {
  error: string;
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
    <SettingsCard
      body="Add the sites that can send SDK data to this project."
      className="flex flex-col gap-4 p-4"
      header={
        origins.length === 0 && (
          <Alert className="mt-4">
            <AlertCircle aria-hidden />
            <AlertTitle>Recorder is blocked</AlertTitle>
            <AlertDescription>
              Recorder requests are blocked until you add your website origin.
            </AlertDescription>
          </Alert>
        )
      }
      title="Allowed origins"
    >
      <>
        {origins.length > 0 && (
          <div className="flex flex-wrap gap-2">
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
        )}
        <div className="flex flex-col gap-2 sm:flex-row">
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
        {(error || saveError).length > 0 && (
          <div className="text-[12px] text-danger">{error || saveError}</div>
        )}
        <p className="text-[11.5px] text-muted-foreground">
          Requests from other origins are rejected at ingest.
        </p>
      </>
    </SettingsCard>
  );
}
