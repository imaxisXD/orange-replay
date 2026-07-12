import { ApiError } from "@/lib/api";

export function readInstallErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.code ?? error.message;
  if (error instanceof Error) return error.message;
  return "The request failed. Try again in a moment.";
}
