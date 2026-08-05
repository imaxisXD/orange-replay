import * as v from "valibot";

export type ValidationIssue = {
  readonly code: string;
  readonly message: string;
  readonly path: readonly (string | number)[];
};

type ValidationIssueInput = {
  readonly message: string;
  readonly path?: readonly (string | number)[];
};

export type ValidationContext = {
  addIssue(issue: ValidationIssueInput): void;
};

type ValidationSuccess<Output> = {
  readonly success: true;
  readonly data: Output;
  readonly error?: never;
};

type ValidationFailure = {
  readonly success: false;
  readonly data?: never;
  readonly error: {
    readonly issues: readonly ValidationIssue[];
  };
};

export class ValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super(issues.map((issue) => issue.message).join("; "));
    this.name = "ValidationError";
    this.issues = issues;
  }
}

/**
 * Keeps the shared schema API stable while Valibot owns validation. Consumers
 * can migrate independently without changing their error handling or field
 * path mapping during this dependency swap.
 */
export type SharedSchema<Schema extends v.GenericSchema> = Schema & {
  parse(input: unknown): v.InferOutput<Schema>;
  safeParse(input: unknown): ValidationSuccess<v.InferOutput<Schema>> | ValidationFailure;
};

export function sharedSchema<const Schema extends v.GenericSchema>(
  schema: Schema,
): SharedSchema<Schema> {
  return Object.assign(schema, {
    parse(input: unknown): v.InferOutput<Schema> {
      const result = v.safeParse(schema, input);
      if (result.success) return result.output;
      throw new ValidationError(normalizeIssues(result.issues));
    },
    safeParse(input: unknown): ValidationSuccess<v.InferOutput<Schema>> | ValidationFailure {
      const result = v.safeParse(schema, input);
      if (result.success) {
        return { success: true, data: result.output };
      }
      return {
        success: false,
        error: {
          issues: normalizeIssues(result.issues),
        },
      };
    },
  });
}

function normalizeIssues(issues: readonly v.BaseIssue<unknown>[]): readonly ValidationIssue[] {
  return issues.map((issue) => ({
    code: issue.type,
    message: issue.message,
    path:
      issue.path?.flatMap(({ key }) =>
        typeof key === "string" || typeof key === "number" ? [key] : [],
      ) ?? [],
  }));
}

/** Runs cross-field checks while keeping the existing string/number paths. */
export function schemaCheck<Input>(
  check: (input: Input, context: ValidationContext) => void,
): v.RawCheckAction<Input> {
  return v.rawCheck(({ dataset, addIssue }) => {
    if (!dataset.typed) return;
    const value = dataset.value as Input;
    check(value, {
      addIssue(issue): void {
        addIssue({
          message: issue.message,
          path: createIssuePath(value, issue.path ?? []),
        });
      },
    });
  });
}

function createIssuePath(
  input: unknown,
  keys: readonly (string | number)[],
): [v.IssuePathItem, ...v.IssuePathItem[]] | undefined {
  if (keys.length === 0) return undefined;

  const path: v.IssuePathItem[] = [];
  let parent = input;
  for (const key of keys) {
    const value = readPathValue(parent, key);
    if (typeof key === "number" && Array.isArray(parent)) {
      path.push({ type: "array", origin: "value", input: parent, key, value });
    } else if (typeof key === "string" && isRecord(parent)) {
      path.push({ type: "object", origin: "value", input: parent, key, value });
    } else {
      path.push({ type: "unknown", origin: "value", input: parent, key, value });
    }
    parent = value;
  }
  return path as [v.IssuePathItem, ...v.IssuePathItem[]];
}

function readPathValue(input: unknown, key: string | number): unknown {
  if (Array.isArray(input) && typeof key === "number") return input[key];
  if (isRecord(input) && typeof key === "string") return input[key];
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
