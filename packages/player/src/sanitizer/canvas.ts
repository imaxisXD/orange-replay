import type { ReplayEvent } from "../types.ts";
import { isPlainRecord, makeSafeRecord } from "./values.ts";

const CANVAS_MUTATION_SOURCE = 9;
const CANVAS_2D_CONTEXT = 0;
const MAX_CANVAS_SIDE = 8_192;
const MAX_CANVAS_PIXELS = 16_000_000;
const MAX_CANVAS_FRAME_BYTES = 512 * 1_024;
const MAX_CANVAS_FRAME_BASE64_CHARACTERS = Math.ceil(MAX_CANVAS_FRAME_BYTES / 3) * 4;
const SAFE_CANVAS_IMAGE_TYPES = new Set(["image/avif", "image/jpeg", "image/png", "image/webp"]);

/**
 * Returns undefined for a non-canvas event, null for a rejected canvas event,
 * and a canonical safe event for Orange Replay's image-frame format.
 */
export function sanitizeCanvasFrameMutation(event: ReplayEvent): ReplayEvent | null | undefined {
  if (!isPlainRecord(event.data) || event.data["source"] !== CANVAS_MUTATION_SOURCE) {
    return undefined;
  }

  const data = event.data;
  const id = readPositiveInteger(data["id"]);
  if (event.type !== 3 || id === undefined || data["type"] !== CANVAS_2D_CONTEXT) {
    return null;
  }

  const commands = data["commands"];
  if (!Array.isArray(commands) || commands.length !== 2) return null;

  const clear = commands[0];
  const draw = commands[1];
  if (!isPlainRecord(clear) || !isPlainRecord(draw)) return null;
  if (clear["property"] !== "clearRect" || draw["property"] !== "drawImage") return null;
  if (clear["setter"] !== undefined || draw["setter"] !== undefined) return null;

  const clearArgs = clear["args"];
  const drawArgs = draw["args"];
  if (!Array.isArray(clearArgs) || !Array.isArray(drawArgs)) return null;
  if (clearArgs.length !== 4 || drawArgs.length !== 5) return null;
  if (clearArgs[0] !== 0 || clearArgs[1] !== 0 || drawArgs[1] !== 0 || drawArgs[2] !== 0) {
    return null;
  }

  const width = readPositiveInteger(clearArgs[2]);
  const height = readPositiveInteger(clearArgs[3]);
  if (
    width === undefined ||
    height === undefined ||
    width > MAX_CANVAS_SIDE ||
    height > MAX_CANVAS_SIDE ||
    width * height > MAX_CANVAS_PIXELS ||
    drawArgs[3] !== width ||
    drawArgs[4] !== height
  ) {
    return null;
  }

  const imageBitmap = drawArgs[0];
  if (!isPlainRecord(imageBitmap) || imageBitmap["rr_type"] !== "ImageBitmap") return null;
  const imageBitmapArgs = imageBitmap["args"];
  if (!Array.isArray(imageBitmapArgs) || imageBitmapArgs.length !== 1) return null;

  const blob = imageBitmapArgs[0];
  if (!isPlainRecord(blob) || blob["rr_type"] !== "Blob") return null;
  const imageType = blob["type"];
  if (typeof imageType !== "string" || !SAFE_CANVAS_IMAGE_TYPES.has(imageType)) return null;
  const blobData = blob["data"];
  if (!Array.isArray(blobData) || blobData.length !== 1) return null;

  const arrayBuffer = blobData[0];
  if (!isPlainRecord(arrayBuffer) || arrayBuffer["rr_type"] !== "ArrayBuffer") return null;
  const base64 = arrayBuffer["base64"];
  if (!isSafeBase64(base64)) return null;

  const safeData = makeSafeRecord();
  safeData["source"] = CANVAS_MUTATION_SOURCE;
  safeData["id"] = id;
  safeData["type"] = CANVAS_2D_CONTEXT;
  safeData["commands"] = [
    { property: "clearRect", args: [0, 0, width, height] },
    {
      property: "drawImage",
      args: [
        {
          rr_type: "ImageBitmap",
          args: [
            {
              rr_type: "Blob",
              data: [{ rr_type: "ArrayBuffer", base64 }],
              type: imageType,
            },
          ],
        },
        0,
        0,
        width,
        height,
      ],
    },
  ];

  return { type: event.type, timestamp: event.timestamp, data: safeData } as ReplayEvent;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isSafeBase64(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CANVAS_FRAME_BASE64_CHARACTERS ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    return false;
  }

  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length * 3) / 4 - padding <= MAX_CANVAS_FRAME_BYTES;
}
