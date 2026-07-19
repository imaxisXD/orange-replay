import { AnimatePresence, m } from "@/lib/motion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AlertCircle, RotateCcw } from "@/lib/icon-map";
import { spring } from "@/lib/springs";
import type { useProjectSettingsEditor } from "./settings-editor-state";
import { CaptureCard, MaskingCard, OriginsCard } from "./settings-cards";
import { SettingsLoading } from "./settings-fields";
import { KeysCard } from "./settings-keys-card";
import { PublicPageCard } from "./settings-public-page-card";
import { SettingsEnvironmentCards } from "./settings-environment";
import type { SettingsSectionId } from "./settings-nav";

type SettingsEditorController = ReturnType<typeof useProjectSettingsEditor>;

// Sections whose content comes from the single shared project-config draft.
// They pull from the editor state (and can surface its load/error/save flow);
// every other section owns its own queries.
const draftSections = new Set<SettingsSectionId>(["capture", "masking", "origins"]);

export function SettingsPanel({
  active,
  editor,
  projectId,
}: {
  active: SettingsSectionId;
  editor: SettingsEditorController;
  projectId: string;
}) {
  return (
    <div className="relative min-w-0">
      {/* Enter-only fade: the new section snaps in with no wait for the old one
          to leave, so switching feels instant. */}
      <m.div
        animate={{ opacity: 1, transform: "translateY(0px)" }}
        initial={{ opacity: 0, transform: "translateY(3px)" }}
        key={active}
        transition={spring.fast}
      >
        <SectionContent active={active} editor={editor} projectId={projectId} />
      </m.div>

      <SettingsSaveBar editor={editor} />
    </div>
  );
}

function SectionContent({
  active,
  editor,
  projectId,
}: {
  active: SettingsSectionId;
  editor: SettingsEditorController;
  projectId: string;
}) {
  if (draftSections.has(active)) {
    return <DraftSection active={active} editor={editor} />;
  }
  if (active === "keys") return <KeysCard projectId={projectId} />;
  if (active === "public") return <PublicPageCard projectId={projectId} />;
  return <SettingsEnvironmentCards />;
}

function DraftSection({
  active,
  editor,
}: {
  active: SettingsSectionId;
  editor: SettingsEditorController;
}) {
  const { state, actions } = editor;

  if (state.configLoading) return <SettingsLoading />;
  if (state.configError.length > 0 || state.draft === null) {
    return (
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
    );
  }

  const draft = state.draft;

  if (active === "capture") {
    return (
      <CaptureCard
        capture={draft.capture}
        retentionDays={draft.retentionDays}
        sampleRate={draft.sampleRate}
        updateDraft={actions.updateDraft}
        onToggle={actions.setCaptureToggle}
      />
    );
  }

  if (active === "masking") {
    return (
      <MaskingCard
        error={state.maskRulesError}
        maskPolicyVersion={draft.maskPolicyVersion}
        onAddRule={actions.addMaskRule}
        onRemoveRule={actions.removeMaskRule}
        onSetAction={actions.setMaskRuleAction}
        onSetSelector={actions.setMaskRuleSelector}
        rules={draft.maskRules}
      />
    );
  }

  return (
    <OriginsCard
      origins={draft.allowedOrigins}
      onRemoveOrigin={actions.removeOrigin}
      updateDraft={actions.updateDraft}
    />
  );
}

function SettingsSaveBar({ editor }: { editor: SettingsEditorController }) {
  const { state, actions } = editor;

  return (
    <AnimatePresence>
      {state.isDirty && (
        <m.div
          animate={{ opacity: 1, y: 0 }}
          className="lit sticky bottom-4 z-20 mt-4 flex flex-col gap-3 rounded-lg p-3 sm:flex-row sm:items-center sm:justify-end"
          exit={{ opacity: 0, y: 8 }}
          initial={{ opacity: 0, y: 8 }}
          transition={spring.moderate}
        >
          <div className="mr-auto text-[12px] text-muted-foreground">Unsaved changes</div>
          {(state.saveError.length > 0 || state.maskRulesError !== null) && (
            <div className="text-[12px] text-danger">{state.saveError || state.maskRulesError}</div>
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
  );
}
