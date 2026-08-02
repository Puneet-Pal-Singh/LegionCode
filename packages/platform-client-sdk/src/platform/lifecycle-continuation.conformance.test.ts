import {
  lifecycleEvent,
  registerLifecycleContinuationConformance,
  type LifecycleContinuationScenario,
} from "@repo/contract-conformance";
import { DefaultPlatformClient } from "./client.js";
import type { PlatformClientTransport } from "./types.js";

const TURN_ID = lifecycleEvent(1).turnId;

registerLifecycleContinuationConformance(
  "DefaultPlatformClient",
  (scenario) => ({
    follow: () =>
      new DefaultPlatformClient(createTransport(scenario)).followTurnLifecycle({
        turnId: TURN_ID,
      }),
  }),
);

function createTransport(
  scenario: LifecycleContinuationScenario,
): PlatformClientTransport {
  const allEvents = [
    ...scenario.replayEvents,
    ...scenario.liveEvents,
  ].sort((a, b) => a.sequence - b.sequence);

  return {
    createThread: unsupported,
    createRun: unsupported,
    startTurn: unsupported,
    getThread: unsupported,
    listThreads: unsupported,
    getRun: unsupported,
    replayRunEvents: unsupported,
    submitApproval: unsupported,
    getArtifact: unsupported,
    listArtifacts: unsupported,
    getWorkspaceManifest: unsupported,
    replayLifecycleEvents: async (request) => {
      const after = request.afterSequence ?? 0;
      const next = allEvents.filter((e) => e.sequence > after);
      return {
        events: next,
        nextSequence: next.at(-1)?.sequence ?? null,
      };
    },
    interruptTurn: unsupported,
    compactTurn: unsupported,
    submitLifecycleApproval: unsupported,
    submitUserInputResponse: unsupported,
    getTurnDiff: unsupported,
  };
}

async function unsupported(): Promise<never> {
  throw new Error("Unsupported conformance operation");
}
