import { describe, expect, it, vi } from "vite-plus/test";
import { removeRetiredAuthStorage } from "@/lib/retired-auth-cleanup";

describe("retired auth cleanup", () => {
  it("deletes the retired bearer token without reading storage", () => {
    const removeItem = vi.fn((_key: string) => undefined);

    removeRetiredAuthStorage({ removeItem });

    expect(removeItem).toHaveBeenCalledOnce();
    expect(removeItem).toHaveBeenCalledWith("or:token");
  });

  it("does not block startup when browser storage is unavailable", () => {
    expect(() =>
      removeRetiredAuthStorage({
        removeItem() {
          throw new Error("storage unavailable");
        },
      }),
    ).not.toThrow();
  });
});
