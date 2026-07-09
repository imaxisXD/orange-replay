import type { ReactNode } from "react";
import { AnimatePresence, m } from "@/lib/motion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertCircle, RotateCcw } from "@/lib/icon-map";
import { cn } from "@/lib/utils";
import { spring } from "@/lib/springs";
import { useProjectSettingsEditor } from "./settings-editor-state";
import { CaptureCard, MaskingCard, OriginsCard } from "./settings-cards";
import { SettingsLoading } from "./settings-fields";

export function SettingsEditor({
  children,
  projectId,
}: {
  children: ReactNode;
  projectId: string;
}) {
  const editor = useProjectSettingsEditor(projectId);
  const { state, actions } = editor;

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
            state.savedVisible ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          <Badge color="green" size="sm" variant="dot">
            Saved
          </Badge>
        </span>
      </div>

      {state.configLoading ? (
        <SettingsLoading />
      ) : state.configError.length > 0 || state.draft === null ? (
        <Alert variant="destructive">
          <AlertCircle aria-hidden />
          <AlertTitle>Could not load project settings</AlertTitle>
          <AlertDescription>
            <p>{state.configError || "Project settings could not be loaded."}</p>
            <Button
              className="mt-2 border-danger-border bg-transparent text-danger-foreground hover:text-foreground"
              leadingIcon={RotateCcw}
              onClick={() => void actions.refetchConfig()}
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
            <CaptureCard
              capture={state.draft.capture}
              retentionDays={state.draft.retentionDays}
              sampleRate={state.draft.sampleRate}
              updateDraft={actions.updateDraft}
              onToggle={actions.setCaptureToggle}
            />
            <MaskingCard
              error={state.maskRulesError}
              maskPolicyVersion={state.draft.maskPolicyVersion}
              onAddRule={actions.addMaskRule}
              onRemoveRule={actions.removeMaskRule}
              onSetAction={actions.setMaskRuleAction}
              onSetSelector={actions.setMaskRuleSelector}
              rules={state.draft.maskRules}
            />
            <OriginsCard
              origins={state.draft.allowedOrigins}
              onRemoveOrigin={actions.removeOrigin}
              updateDraft={actions.updateDraft}
            />
            {children}
          </div>

          <AnimatePresence>
            {state.isDirty && (
              <m.div
                animate={{ opacity: 1, y: 0 }}
                className="lit sticky bottom-4 z-20 flex flex-col gap-3 rounded-lg p-3 sm:flex-row sm:items-center sm:justify-end"
                exit={{ opacity: 0, y: 8 }}
                initial={{ opacity: 0, y: 8 }}
                transition={spring.moderate}
              >
                <div className="mr-auto text-[12px] text-dim">Unsaved changes</div>
                {(state.saveError.length > 0 || state.maskRulesError !== null) && (
                  <div className="text-[12px] text-danger">
                    {state.saveError || state.maskRulesError}
                  </div>
                )}
                <Button onClick={actions.discardChanges} size="sm" variant="secondary">
                  Discard
                </Button>
                <Button
                  disabled={!state.canSave}
                  loading={state.saveState === "saving"}
                  onClick={actions.saveChanges}
                  size="sm"
                >
                  Save changes
                </Button>
              </m.div>
            )}
          </AnimatePresence>
        </>
      )}
    </div>
  );
}
