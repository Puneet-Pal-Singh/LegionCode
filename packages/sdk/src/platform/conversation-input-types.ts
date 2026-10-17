import type { ThreadInputCommand } from "@repo/platform-protocol";

export type ResumeTurnCommand = Extract<
  ThreadInputCommand,
  { operation: "turn.resume" }
>;
export type SteerTurnCommand = Extract<
  ThreadInputCommand,
  { operation: "turn.steer" }
>;
export type EnqueueThreadInputCommand = Extract<
  ThreadInputCommand,
  { operation: "thread.input.enqueue" }
>;
export type ListThreadInputsCommand = Extract<
  ThreadInputCommand,
  { operation: "thread.input.list" }
>;
export type UpdateThreadInputCommand = Extract<
  ThreadInputCommand,
  { operation: "thread.input.update" }
>;
export type RemoveThreadInputCommand = Extract<
  ThreadInputCommand,
  { operation: "thread.input.remove" }
>;
export type SteerQueuedThreadInputCommand = Extract<
  ThreadInputCommand,
  { operation: "thread.input.steer" }
>;
export type StartQueuedThreadInputCommand = Extract<
  ThreadInputCommand,
  { operation: "thread.input.start" }
>;
