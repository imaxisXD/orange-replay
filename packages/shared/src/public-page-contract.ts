import * as v from "valibot";
import { MAX_PUBLIC_PAGE_RECORDINGS } from "./constants.ts";
import { generatedRecorderKeySchema } from "./project-key-contract.ts";
import { PROJECT_NAME_MAX_CHARS } from "./project-contract.ts";
import type {
  PublicPageAnalytics,
  PublicPageBreakdownItem,
  PublicPageData,
  PublicPageRecording,
  PublicPageSelectedRecording,
  PublicPageSettings,
  PublicPageSettingsUpdate,
} from "./types.ts";
import { schemaCheck, sharedSchema, type SharedSchema } from "./validation.ts";

const MAX_PUBLIC_BREAKDOWN_ROWS = 30;
const MAX_PUBLIC_LABEL_CHARS = 2_048;
const MAX_PUBLIC_URL_CHARS = 2_048;
const pathIdSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,64}$/));
const nonnegativeFiniteNumberSchema = v.pipe(v.number(), v.finite(), v.minValue(0));
const nonnegativeSafeIntegerSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const optionalPublicLabelSchema = v.nullable(
  v.pipe(v.string(), v.maxLength(MAX_PUBLIC_LABEL_CHARS)),
);
const publicUrlSchema = v.pipe(
  v.string(),
  v.maxLength(MAX_PUBLIC_URL_CHARS),
  v.url(),
  v.check(isHttpUrl, "public page URL must use HTTP or HTTPS"),
);

const publicPageBreakdownItemObjectSchema = v.object({
  label: v.pipe(v.string(), v.maxLength(MAX_PUBLIC_LABEL_CHARS)),
  count: nonnegativeSafeIntegerSchema,
  share: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1)),
});

export const publicPageBreakdownItemSchema: SharedSchema<
  v.GenericSchema<PublicPageBreakdownItem, PublicPageBreakdownItem>
> = sharedSchema(publicPageBreakdownItemObjectSchema);

const publicPageRecordingObjectSchema = v.object({
  replayId: pathIdSchema,
  position: v.pipe(nonnegativeSafeIntegerSchema, v.maxValue(MAX_PUBLIC_PAGE_RECORDINGS - 1)),
  startedAt: nonnegativeSafeIntegerSchema,
  durationMs: nonnegativeFiniteNumberSchema,
  entryPath: v.pipe(
    v.string(),
    v.maxLength(MAX_PUBLIC_URL_CHARS),
    v.check(
      (value) => value.startsWith("/") && !value.startsWith("//"),
      "entry path must be a relative path",
    ),
  ),
  country: optionalPublicLabelSchema,
  device: optionalPublicLabelSchema,
  browser: optionalPublicLabelSchema,
  operatingSystem: optionalPublicLabelSchema,
  clicks: nonnegativeSafeIntegerSchema,
  errors: nonnegativeSafeIntegerSchema,
  rages: nonnegativeSafeIntegerSchema,
  pages: v.nullable(nonnegativeSafeIntegerSchema),
});

export const publicPageRecordingSchema: SharedSchema<
  v.GenericSchema<PublicPageRecording, PublicPageRecording>
> = sharedSchema(publicPageRecordingObjectSchema);

const publicPageSelectedRecordingObjectSchema = v.object({
  sessionId: pathIdSchema,
  ...publicPageRecordingObjectSchema.entries,
});

export const publicPageSelectedRecordingSchema: SharedSchema<
  v.GenericSchema<PublicPageSelectedRecording, PublicPageSelectedRecording>
> = sharedSchema(publicPageSelectedRecordingObjectSchema);

const publicPageAnalyticsObjectSchema = v.object({
  sessions: nonnegativeSafeIntegerSchema,
  averageDurationMs: nonnegativeFiniteNumberSchema,
  p50DurationMs: nonnegativeFiniteNumberSchema,
  clicks: nonnegativeSafeIntegerSchema,
  pagesPerSession: v.nullable(nonnegativeFiniteNumberSchema),
  pagesCoveredSessions: nonnegativeSafeIntegerSchema,
  ragePercent: v.nullable(v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1))),
  quickBackPercent: v.nullable(v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1))),
  countries: publicBreakdownArraySchema(),
  devices: publicBreakdownArraySchema(),
  browsers: publicBreakdownArraySchema(),
  operatingSystems: publicBreakdownArraySchema(),
  entryPages: publicBreakdownArraySchema(),
});

export const publicPageAnalyticsSchema: SharedSchema<
  v.GenericSchema<PublicPageAnalytics, PublicPageAnalytics>
> = sharedSchema(publicPageAnalyticsObjectSchema);

export const publicPageDataSchema: SharedSchema<v.GenericSchema<PublicPageData, PublicPageData>> =
  sharedSchema(
    v.object({
      version: v.literal(1),
      publicId: pathIdSchema,
      publicUrl: publicUrlSchema,
      projectName: v.pipe(v.string(), v.minLength(1), v.maxLength(PROJECT_NAME_MAX_CHARS)),
      generatedAt: nonnegativeSafeIntegerSchema,
      analytics: publicPageAnalyticsObjectSchema,
      recordings: v.pipe(
        v.array(publicPageRecordingObjectSchema),
        v.maxLength(MAX_PUBLIC_PAGE_RECORDINGS),
      ),
    }),
  );

export const publicPageSettingsSchema: SharedSchema<
  v.GenericSchema<PublicPageSettings, PublicPageSettings>
> = sharedSchema(
  v.pipe(
    v.object({
      enabled: v.boolean(),
      publicId: v.nullable(pathIdSchema),
      publicUrl: v.nullable(publicUrlSchema),
      revision: nonnegativeSafeIntegerSchema,
      recordings: v.pipe(
        v.array(publicPageSelectedRecordingObjectSchema),
        v.maxLength(MAX_PUBLIC_PAGE_RECORDINGS),
      ),
    }),
    schemaCheck<PublicPageSettings>((settings, context) => {
      if ((settings.publicId === null) !== (settings.publicUrl === null)) {
        context.addIssue({
          message: "public page id and URL must both be present or both be null",
          path: [settings.publicId === null ? "publicUrl" : "publicId"],
        });
      }
      addUniqueIssues(
        settings.recordings.map((recording) => recording.sessionId),
        "session id",
        ["recordings"],
        context,
      );
      addUniqueIssues(
        settings.recordings.map((recording) => recording.replayId),
        "replay id",
        ["recordings"],
        context,
      );
    }),
  ),
);

export const publicPageSettingsUpdateSchema: SharedSchema<
  v.GenericSchema<PublicPageSettingsUpdate, PublicPageSettingsUpdate>
> = sharedSchema(
  v.pipe(
    v.strictObject({
      enabled: v.boolean(),
      expectedRevision: nonnegativeSafeIntegerSchema,
      sessionIds: v.pipe(v.array(pathIdSchema), v.maxLength(MAX_PUBLIC_PAGE_RECORDINGS)),
    }),
    schemaCheck<PublicPageSettingsUpdate>((update, context) => {
      addUniqueIssues(update.sessionIds, "session id", ["sessionIds"], context);
    }),
  ),
);

export const installStatusResponseSchema = sharedSchema(
  v.object({
    firstEventAt: v.nullable(nonnegativeSafeIntegerSchema),
  }),
);

export const demoWorkspaceResponseSchema = sharedSchema(
  v.object({
    projectId: pathIdSchema,
    recorderKey: generatedRecorderKeySchema,
  }),
);

export type InstallStatusResponse = v.InferOutput<typeof installStatusResponseSchema>;
export type DemoWorkspaceResponse = v.InferOutput<typeof demoWorkspaceResponseSchema>;

export function decodePublicPageData(value: unknown): PublicPageData {
  return publicPageDataSchema.parse(value);
}

export function decodePublicPageSettings(value: unknown): PublicPageSettings {
  return publicPageSettingsSchema.parse(value);
}

export function decodeInstallStatusResponse(value: unknown): InstallStatusResponse {
  return installStatusResponseSchema.parse(value);
}

export function decodeDemoWorkspaceResponse(value: unknown): DemoWorkspaceResponse {
  return demoWorkspaceResponseSchema.parse(value);
}

function publicBreakdownArraySchema() {
  return v.pipe(
    v.array(publicPageBreakdownItemObjectSchema),
    v.maxLength(MAX_PUBLIC_BREAKDOWN_ROWS),
  );
}

function addUniqueIssues(
  values: readonly string[],
  label: string,
  path: readonly (string | number)[],
  context: { addIssue(issue: { message: string; path: readonly (string | number)[] }): void },
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({ message: `${label} must be unique`, path: [...path, index] });
    }
    seen.add(value);
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
