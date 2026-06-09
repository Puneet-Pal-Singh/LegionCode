import { z } from "zod";

export const HookEventNameSchema = z.enum([
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
  "Stop",
]);
export type HookEventName = z.infer<typeof HookEventNameSchema>;

export const PrivateAlphaHookEventNameSchema = z.enum([
  "SessionStart",
  "UserPromptSubmit",
  "PermissionRequest",
  "Stop",
]);
export type PrivateAlphaHookEventName = z.infer<
  typeof PrivateAlphaHookEventNameSchema
>;

export const MatcherAwareHookEventNameSchema = z.enum([
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "SubagentStart",
  "SubagentStop",
]);
export type MatcherAwareHookEventName = z.infer<
  typeof MatcherAwareHookEventNameSchema
>;

export const HOOK_EVENT_NAMES = HookEventNameSchema.options;
export const PRIVATE_ALPHA_HOOK_EVENT_NAMES =
  PrivateAlphaHookEventNameSchema.options;
export const MATCHER_AWARE_HOOK_EVENT_NAMES =
  MatcherAwareHookEventNameSchema.options;

export function isPrivateAlphaHookEventName(
  eventName: HookEventName,
): eventName is PrivateAlphaHookEventName {
  return PRIVATE_ALPHA_HOOK_EVENT_NAMES.some(
    (privateAlphaEventName) => privateAlphaEventName === eventName,
  );
}
