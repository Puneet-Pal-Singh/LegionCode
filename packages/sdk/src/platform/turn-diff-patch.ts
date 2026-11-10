import { buildDiffContentFromPatch, type DiffContent } from "@repo/shared-types";
import type { TurnDiffPayload } from "@repo/platform-protocol";

export function buildDiffContentFromTurnDiff(
  turnDiff: TurnDiffPayload,
  path: string,
): DiffContent | null {
  return buildDiffContentFromPatch(turnDiff.patch, path);
}
