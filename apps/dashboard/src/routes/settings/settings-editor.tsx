import { AnimatePresence, m } from "@/lib/motion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { EmberField } from "@/components/ember-field";
import { DashboardDock } from "@/lib/dashboard-dock";
import { AlertCircle, RotateCcw } from "@/lib/icon-map";
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

  // The dock lives outside the scroll area (see lib/dashboard-dock), so it
  // reproduces the shell's content column and the settings grid to stay aligned
  // with the card it belongs to.
  return (
    <DashboardDock>
      {/* Separate presences, not one wrapper: each layer animates on its own
          terms (the scrim and field only fade, the bar rises) and
          AnimatePresence tracks direct children only. The scrim is full-bleed
          so the glass has no vertical seam beside the bar. */}
      <AnimatePresence>
        {state.isDirty && (
          <m.div
            animate={{ opacity: 1 }}
            aria-hidden
            className="save-dock-scrim"
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            transition={spring.moderate}
          />
        )}
      </AnimatePresence>

      {/* The banner notch's LED ember field as its own layer, in amber rather
          than the notch's teal: full dock width, brightest along the bottom
          edge, rising behind the bar and fading out at its top. Offset 3px past
          the edge because the lattice draws its bottom row a cell-height up.
          Opacity-only so the lattice never relayouts mid-animation. */}
      <AnimatePresence>
        {state.isDirty && (
          <m.div
            animate={{ opacity: 1 }}
            aria-hidden
            className="pointer-events-none absolute inset-x-0 -bottom-[3px] h-24"
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            transition={spring.moderate}
          >
            <EmberField
              className="inset-0 h-full w-full text-amber"
              fadePerRow={0.055}
              intensity={2.8}
              pulse={1.6}
            />
          </m.div>
        )}
      </AnimatePresence>

      {/* The dock spans the window, so it re-adds the shell's frame inset before
          reproducing main's content column and the settings grid — that is what
          keeps the bar aligned with the card it belongs to. */}
      <div className="px-2 pb-2 sm:px-3 sm:pb-3">
        <div className="mx-auto w-full max-w-300 px-4 pb-5 sm:px-7 sm:pb-6">
          <div className="grid gap-5 md:grid-cols-[204px_minmax(0,1fr)]">
            <div aria-hidden className="hidden md:block" />
            <div className="relative">
              <AnimatePresence>
                {state.isDirty && (
                  <m.div
                    animate={{ opacity: 1, y: 0 }}
                    className="lit save-dock-bar pointer-events-auto relative flex flex-col gap-3 rounded-lg p-3 sm:flex-row sm:items-center sm:justify-end"
                    exit={{ opacity: 0, y: 24 }}
                    initial={{ opacity: 0, y: 24 }}
                    transition={spring.slow}
                  >
                    {/* The bar's own statement, so it carries the same weight as a
                      card's row title rather than reading as a caption under the
                      buttons it belongs to. */}
                    <div className="mr-auto text-[13px] font-medium whitespace-nowrap">
                      Unsaved changes
                    </div>
                    {(state.saveError.length > 0 || state.maskRulesError !== null) && (
                      <div className="max-w-[46ch] text-[12px] leading-normal text-pretty text-danger">
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
            </div>
          </div>
        </div>
      </div>
    </DashboardDock>
  );
}
