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
  return {
    createThread: unsupported,
    createRun: unsupported,
    startTurn: unsupported,
    getThread: unsupported,
    listThreads: unsupported,
    getRun: unsupported,
    attachRunStream: unsupportedStream,
    replayRunEvents: unsupported,
    submitApproval: unsupported,
    getArtifact: unsupported,
    listArtifacts: unsupported,
    getWorkspaceManifest: unsupported,
    replayLifecycleEvents: async () => ({
      events: scenario.replayEvents,
      nextSequence: scenario.replayEvents.at(-1)?.sequence ?? null,
    }),
    attachLifecycleStream: async function* () {
      yield* scenario.liveEvents;
    },
    submitLifecycleApproval: unsupported,
    submitUserInputResponse: unsupported,
    getTurnDiff: unsupported,
  };
}

async function unsupported(): Promise<never> {
  throw new Error("Unsupported conformance operation");
}

async function* unsupportedStream(): AsyncIterable<never> {
  await unsupported();
  yield undefined as never;
}
