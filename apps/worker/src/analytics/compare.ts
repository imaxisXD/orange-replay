/**
 * D1 keeps a small error sample for replay search. It cannot prove the exact
 * session set for one error message, while the warehouse keeps every sidecar
 * error. Treat that filter as useful shadow data, not a mismatch.
 */
export function canCompareD1Exactly(filter: { error_detail?: string }): boolean {
  return filter.error_detail === undefined;
}
