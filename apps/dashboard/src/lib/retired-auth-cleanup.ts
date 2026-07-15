const RETIRED_TOKEN_STORAGE_KEY = "or:token";

/** Removes the retired shared bearer token without ever reading or sending it. */
export function removeRetiredAuthStorage(
  storage: Pick<Storage, "removeItem"> = window.localStorage,
): void {
  try {
    storage.removeItem(RETIRED_TOKEN_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}
