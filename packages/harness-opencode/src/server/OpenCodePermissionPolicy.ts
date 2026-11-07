import type { SessionCreateInput } from "@opencode/client";
import { Permission } from "@opencode/schema/permission";
import { Schema } from "effect";
import { OpenCodeTransportError } from "./OpenCodeClient.js";

type Rules = NonNullable<SessionCreateInput["permissions"]>;

/** Native policy representation only. The canonical policy authority owns resolution and attestation. */
export function captureNativePermissions(value: unknown): Rules {
  if (
    !Schema.is(Schema.toEncoded(Permission.Ruleset))(value) ||
    value.length === 0 ||
    value.some((rule) =>
      Object.keys(rule).some(
        (key) => !["action", "resource", "effect"].includes(key),
      ),
    )
  ) {
    throw new OpenCodeTransportError("native policy representation", false);
  }
  return Object.freeze(
    value.map((rule) =>
      Object.freeze({
        action: rule.action,
        resource: rule.resource,
        effect: rule.effect,
      }),
    ),
  );
}

/** Preserve rule order, which affects native evaluation; object key order has no policy meaning. */
export function sameNativePermissions(
  expected: Rules,
  actual: Rules | undefined,
): boolean {
  return (
    actual !== undefined &&
    JSON.stringify(expected.map(ruleKey)) ===
      JSON.stringify(actual.map(ruleKey))
  );
}

function ruleKey(rule: Rules[number]): readonly string[] {
  return [rule.action, rule.resource, rule.effect];
}
