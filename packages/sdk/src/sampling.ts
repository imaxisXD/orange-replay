// Single source of truth lives in shared so the ingest worker's
// server-side re-check can never drift from the client decision.
export { hashToUnit, shouldSampleSession } from "@orange-replay/shared/sampling";
