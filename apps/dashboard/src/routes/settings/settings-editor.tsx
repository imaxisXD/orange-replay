import { m } from "@/lib/motion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DockBar } from "@/components/dock-bar";
import { AlertCircle, AlertTriangle, Check, RotateCcw } from "@/lib/icon-map";
import { spring } from "@/lib/springs";
import { cn } from "@/lib/utils";
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
    <div
      className={cn(
        "relative min-w-0",
        // Room to scroll the last control clear of the dock while it is up.
        editor.state.isDirty && "pb-24",
      )}
    >
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
  const error = state.saveError || state.maskRulesError;

  // The settings grid is this screen's own concern, so it wraps the bar rather
  // than living inside the shared dock: an empty first cell holds the nav
  // column's width, keeping the bar aligned with the card above it.
  return (
    <DockBar open={state.isDirty}>
      <div className="grid gap-5 md:grid-cols-[204px_minmax(0,1fr)]">
        <div aria-hidden className="hidden md:block" />
        <DockBar.Bar>
          <DockBar.Status icon={AlertTriangle}>Unsaved changes</DockBar.Status>
          {error === null || error.length === 0 ? null : (
            <DockBar.Message className="text-danger">{error}</DockBar.Message>
          )}
          <Button onClick={actions.discardChanges} size="sm" variant="ghost">
            Discard
          </Button>
          <Button
            disabled={!state.canSave}
            leadingIcon={Check}
            loading={state.saveState === "saving"}
            onClick={actions.saveChanges}
            size="sm"
          >
            Save changes
          </Button>
        </DockBar.Bar>
      </div>
    </DockBar>
  );
}
