import { describe, expect, it, vi } from "vitest";
import type {
  LifecycleClient,
  LifecycleEvent,
  TurnId,
} from "../../services/api/lifecycleClient";
import { hasCanonicalLifecycleEvidence } from "./resolveChatTransportFailure";

const TURN_ID = "trn_transport001" as TurnId;

describe("hasCanonicalLifecycleEvidence", () => {
  it("treats the first replayed lifecycle event as accepted run evidence", async () => {
    const event = {
      id: "evt_transport001",
      sequence: 1,
      type: "turn.started",
      turnId: TURN_ID,
      occurredAt: "2026-07-28T00:00:00.000Z",
      payload: {},
    } as unknown as LifecycleEvent;
    const lifecycleClient = {
      followTurnLifecycle: vi.fn(async function* () {
        yield event;
      }),
    } as unknown as LifecycleClient;

    await expect(
      hasCanonicalLifecycleEvidence(lifecycleClient, TURN_ID),
    ).resolves.toBe(true);
  });

  it("does not hide a transport failure when canonical replay has no evidence", async () => {
    const lifecycleClient = {
      followTurnLifecycle: vi.fn(async function* () {
        yield* [];
        return;
      }),
    } as unknown as LifecycleClient;

    await expect(
      hasCanonicalLifecycleEvidence(lifecycleClient, TURN_ID),
    ).resolves.toBe(false);
  });
});
