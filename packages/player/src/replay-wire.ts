import { batchIndexSchema } from "@orange-replay/shared/schemas";
import { decodeIngestBody } from "@orange-replay/shared/wire";

export function decodeReplayIngestBody(bytes: Uint8Array): ReturnType<typeof decodeIngestBody> {
  const decoded = decodeIngestBody(bytes);
  return validateDecodedIngestBody(decoded);
}

export function tryDecodeReplayIngestBody(
  bytes: Uint8Array,
): ReturnType<typeof decodeIngestBody> | undefined {
  let decoded: ReturnType<typeof decodeIngestBody>;
  try {
    decoded = decodeIngestBody(bytes);
  } catch {
    return undefined;
  }
  return validateDecodedIngestBody(decoded);
}

function validateDecodedIngestBody(
  decoded: ReturnType<typeof decodeIngestBody>,
): ReturnType<typeof decodeIngestBody> {
  return {
    index: batchIndexSchema.parse(decoded.index),
    payload: decoded.payload,
  };
}
