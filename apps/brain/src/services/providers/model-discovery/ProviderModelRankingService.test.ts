import { describe, expect, it } from "vitest";
import { ProviderModelRankingService } from "@repo/provider-core/discovery";

describe("ProviderModelRankingService", () => {
  it("returns deterministic order for equal inputs", async () => {
    const service = new ProviderModelRankingService();
    const input = {
      providerId: "google",
      models: [
        { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro", providerId: "google" },
        { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash", providerId: "google" },
      ],
      signals: {
        modelSelectionFrequency: {
          "gemini-1.5-pro": 10,
          "gemini-1.5-flash": 10,
        },
        successfulRunFrequency: {
          "gemini-1.5-pro": 5,
          "gemini-1.5-flash": 5,
        },
        providerDeclaredBoost: {},
        capabilityFit: {},
        costEfficiency: {},
      },
      limit: 50,
    } as const;

    const first = await service.computePopular(input);
    const second = await service.computePopular(input);

    expect(first.models.map((m) => m.id)).toEqual(second.models.map((m) => m.id));
    expect(first.models[0].id).toBe("gemini-1.5-flash");
    expect(first.models[1].id).toBe("gemini-1.5-pro");
  });
});
