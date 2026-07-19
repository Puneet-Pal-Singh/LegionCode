import { describe, expect, it } from "vitest";
import type { HookDefinition } from "../api/hookDefinitionsClient.js";
import type { HookSettingsAuditReadModel } from "../api/lifecycleClient.js";
import { buildHookSettingsViewModel } from "./HookSettingsViewModel.js";

const userDefinition: HookDefinition = {
  handlerId: "personal.prompt",
  eventName: "UserPromptSubmit",
  source: "user",
  displayName: "Prompt preflight",
  enabled: true,
  order: 20,
  timeoutMs: 500,
  configurationKey: "hooks.personal.prompt",
};

describe("buildHookSettingsViewModel", () => {
  it("groups server definitions and joins only matching canonical audit state", () => {
    const audits: HookSettingsAuditReadModel[] = [
      {
        handlerId: userDefinition.handlerId,
        source: "user",
        eventName: "UserPromptSubmit",
        lastStatus: "completed",
        lastRunAt: "2026-07-19T10:00:00.000Z",
        lastDurationMs: 220,
        lastError: null,
      },
    ];
    const [group] = buildHookSettingsViewModel({
      definitions: [
        {
          ...userDefinition,
          handlerId: "project.prompt",
          source: "project",
          displayName: "Project preflight",
          configurationKey: "/never/render/this/path",
        },
        userDefinition,
      ],
      audits,
    });

    expect(group).toMatchObject({ label: "User prompt submit" });
    expect(group?.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          handlerId: userDefinition.handlerId,
          canEdit: true,
          statusLabel: "Completed",
          observedLabel: "Observed 2026-07-19 10:00:00 UTC",
          durationLabel: "220ms",
          configurationLabel: "Workspace configuration",
        }),
        expect.objectContaining({
          handlerId: "project.prompt",
          canEdit: false,
          statusLabel: "Not observed",
          observedLabel: "No canonical audit yet",
          configurationLabel: "Workspace configuration",
        }),
      ]),
    );
    expect(JSON.stringify(group)).not.toContain("/never/render/this/path");
  });
});
