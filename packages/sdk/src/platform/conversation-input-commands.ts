import {
  EnqueueThreadInputCommandSchema,
  ResumeTurnCommandSchema,
  SteerTurnCommandSchema,
  type ThreadInputConfiguration,
} from "@repo/platform-protocol";
import type { ConversationScope } from "./conversation-scope.js";
import type {
  EnqueueThreadInputCommand,
  ResumeTurnCommand,
  SteerTurnCommand,
} from "./conversation-input-types.js";
import type { PlatformClient } from "./types.js";

type FollowUpCommand = EnqueueThreadInputCommand | SteerTurnCommand;
type InputClient = Pick<
  PlatformClient,
  "enqueueThreadInput" | "steerTurn" | "resumeTurn"
>;

/** One conversation binding's retained commands; never a global product store. */
export function createConversationInputCommands() {
  const deliveries = new Map<string, FollowUpCommand>();
  let resume: { fingerprint: string; command: ResumeTurnCommand } | null = null;

  return {
    async submitFollowUp(client: InputClient, input: {
      fingerprint: string;
      scope: ConversationScope;
      delivery: "queue" | "steer";
      content: EnqueueThreadInputCommand["content"];
      configuration: ThreadInputConfiguration;
    }) {
      let command = deliveries.get(input.fingerprint);
      if (!command) {
        const identity = {
          clientInputId: crypto.randomUUID(),
          threadId: input.scope.threadId,
          workspaceId: input.scope.workspaceId,
          content: input.content,
        };
        // Schema parsing captures independent content/configuration objects so
        // uncertain delivery retries cannot pick up later draft/image changes.
        command = input.delivery === "steer"
          ? SteerTurnCommandSchema.parse({
              ...identity,
              operation: "turn.steer",
              expectedTurnId: input.scope.turnId,
              expectedRunAttemptId: input.scope.runAttemptId,
            })
          : EnqueueThreadInputCommandSchema.parse({
              ...identity,
              operation: "thread.input.enqueue",
              configuration: input.configuration,
            });
        deliveries.set(input.fingerprint, command);
      }
      const receipt = command.operation === "turn.steer"
        ? await client.steerTurn(command)
        : await client.enqueueThreadInput(command);
      // A typed response ends this delivery attempt. A thrown transport error
      // retains the exact command and client identity for an explicit retry.
      deliveries.delete(input.fingerprint);
      return receipt;
    },

    async resumeInterruptedTurn(client: InputClient, input: {
      fingerprint: string;
      scope: ConversationScope;
      expectedTerminalSequence: number;
      configuration: ThreadInputConfiguration;
    }) {
      if (!resume || resume.fingerprint !== input.fingerprint) {
        resume = {
          fingerprint: input.fingerprint,
          command: ResumeTurnCommandSchema.parse({
            operation: "turn.resume",
            clientCommandId: crypto.randomUUID(),
            threadId: input.scope.threadId,
            workspaceId: input.scope.workspaceId,
            expectedTurnId: input.scope.turnId,
            expectedRunAttemptId: input.scope.runAttemptId,
            expectedTerminalSequence: input.expectedTerminalSequence,
            configuration: input.configuration,
          }),
        };
      }
      const receipt = await client.resumeTurn(resume.command);
      if (resume?.fingerprint === input.fingerprint) resume = null;
      return receipt;
    },
  };
}
