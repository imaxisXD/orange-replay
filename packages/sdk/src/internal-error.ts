const SDK_INTERNAL_ERROR = Symbol("orange-replay-internal-error");

type InternalErrorObject = {
  [SDK_INTERNAL_ERROR]?: true;
};

export function markSdkInternalError(error: unknown): unknown {
  if (typeof error === "object" && error !== null) {
    try {
      Object.defineProperty(error, SDK_INTERNAL_ERROR, {
        configurable: true,
        value: true,
      });
    } catch {
      /* some browser error objects are read-only */
    }

    return error;
  }

  const wrapped = new Error(messageFromSimpleValue(error));
  return markSdkInternalError(wrapped);
}

export function isSdkInternalError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as InternalErrorObject)[SDK_INTERNAL_ERROR] === true
  );
}

function messageFromSimpleValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  ) {
    return String(value);
  }

  return "Orange Replay internal error.";
}
