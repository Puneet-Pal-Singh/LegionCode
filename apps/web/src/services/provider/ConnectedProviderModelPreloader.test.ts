import { describe, expect, it, vi } from "vitest";
import { preloadConnectedProviderModels } from "./ConnectedProviderModelPreloader";

describe("preloadConnectedProviderModels", () => {
  it("does not hydrate a reset workspace after the picker request settles", async () => {
    let current = true;
    const loadPickerModels = vi.fn(async () => {
      current = false;
    });
    const loadManageModels = vi.fn(async () => undefined);

    await preloadConnectedProviderModels({
      catalog: [{ providerId: "openai" } as never],
      credentials: [
        {
          providerId: "openai",
          status: "connected",
          deletedAt: null,
        } as never,
      ],
      loadPickerModels,
      loadManageModels,
      isCurrent: () => current,
    });

    expect(loadPickerModels).toHaveBeenCalledWith("openai");
    expect(loadManageModels).not.toHaveBeenCalled();
  });
});
