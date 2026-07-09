import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CaptureToggles, ProjectConfigUpdate } from "@orange-replay/shared/types";
import { ApiError, fetchProjectConfig, saveProjectConfig } from "@/lib/api";
import {
  cleanMaskRules,
  makeProjectSettingsDraft,
  projectSettingsAreDirty,
  removeAllowedOrigin,
  updateMaskRules,
  validateMaskRules,
  type MaskRuleActionValue,
  type ProjectSettingsDraft,
} from "@/lib/project-settings";

export type SaveState = "idle" | "saving";

interface DraftState {
  baseKey: string;
  draft: ProjectSettingsDraft;
}

export function useProjectSettingsEditor(projectId: string) {
  const queryClient = useQueryClient();
  const [draftState, setDraftState] = useState<DraftState | null>(null);
  const [saveError, setSaveError] = useState("");
  const [savedVisible, setSavedVisible] = useState(false);
  const configQuery = useQuery({
    queryKey: ["project-config", projectId],
    queryFn: () => fetchProjectConfig(projectId),
  });
  const saveMutation = useMutation({
    mutationFn: (update: ProjectConfigUpdate) => saveProjectConfig(projectId, update),
    onSuccess: (savedConfig) => {
      queryClient.setQueryData(["project-config", projectId], savedConfig);
      setDraftState(null);
      setSavedVisible(true);
    },
    onError: (caughtError) => {
      if (caughtError instanceof ApiError && caughtError.status === 409) {
        void configQuery.refetch();
        setDraftState(null);
        setSaveError(
          "Project settings changed elsewhere. Review the latest values and save again.",
        );
        return;
      }
      setSaveError(readErrorMessage(caughtError));
    },
  });

  const config = configQuery.data ?? null;
  const savedDraft = config === null ? null : makeProjectSettingsDraft(config);
  const draftBaseKey = config === null ? "" : `${projectId}:${config.version}`;
  const draft =
    draftState !== null && draftState.baseKey === draftBaseKey ? draftState.draft : savedDraft;
  const configError = configQuery.error === null ? "" : readErrorMessage(configQuery.error);
  const saveState: SaveState = saveMutation.isPending ? "saving" : "idle";
  const maskRulesError = draft === null ? null : validateMaskRules(draft.maskRules);
  const isDirty = config !== null && draft !== null && projectSettingsAreDirty(config, draft);
  const canSave = isDirty && saveState !== "saving" && maskRulesError === null;

  useEffect(() => {
    if (!savedVisible) return;
    const timeoutId = window.setTimeout(() => setSavedVisible(false), 2_000);
    return () => window.clearTimeout(timeoutId);
  }, [savedVisible]);

  function updateDraft(
    updater: (currentDraft: ProjectSettingsDraft) => ProjectSettingsDraft,
  ): void {
    setSaveError("");
    setSavedVisible(false);
    saveMutation.reset();
    setDraftState((currentState) => {
      const currentDraft =
        currentState !== null && currentState.baseKey === draftBaseKey
          ? currentState.draft
          : savedDraft;
      if (currentDraft === null || draftBaseKey.length === 0) return currentState;
      return { baseKey: draftBaseKey, draft: updater(currentDraft) };
    });
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

  function removeOrigin(origin: string): void {
    updateDraft((currentDraft) => ({
      ...currentDraft,
      allowedOrigins: removeAllowedOrigin(currentDraft.allowedOrigins, origin),
    }));
  }

  function discardChanges(): void {
    setDraftState(null);
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

  return {
    actions: {
      addMaskRule,
      discardChanges,
      refetchConfig: () => configQuery.refetch(),
      removeMaskRule,
      removeOrigin,
      saveChanges,
      setCaptureToggle,
      setMaskRuleAction,
      setMaskRuleSelector,
      updateDraft,
    },
    state: {
      canSave,
      configError,
      configLoading: configQuery.isPending,
      draft,
      isDirty,
      maskRulesError,
      saveError,
      savedVisible,
      saveState,
    },
  };
}

function readErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.code ?? error.message;
  if (error instanceof Error) return error.message;
  return "The API request failed.";
}
