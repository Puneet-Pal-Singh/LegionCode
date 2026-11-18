import type { Env } from "../index";
import {
  QUALIFICATION_ENVIRONMENT, QualificationControlPropsSchema, QualificationPinsSchema,
  freezeQualification, type QualificationControlProps, type QualificationPins,
} from "./contracts";

export interface QualificationPolicy {
  readonly subject: QualificationControlProps;
  readonly pins: QualificationPins;
  readonly secret: string;
}
export interface QualificationAuthorization {
  readonly props: QualificationControlProps;
  readonly secret: string;
  readonly bearer: string;
}
export function isQualificationEnvironment(env: unknown): boolean {
  return !!env && typeof env === "object" && "ENVIRONMENT" in env && env.ENVIRONMENT === QUALIFICATION_ENVIRONMENT;
}
export function qualificationPolicy(env: Env): QualificationPolicy {
  const values = env as unknown as Record<string, unknown>;
  const allowed = new Set(["AGENT_RUNTIME", "Sandbox", "ENVIRONMENT", "RUNTIME_GIT_SHA", "INTERNAL_RUNTIME_EVENT_SECRET",
    "NATIVE_QUALIFICATION_OPERATOR_ACCOUNT_ID", "NATIVE_QUALIFICATION_CONTROL_PRINCIPAL", "NATIVE_QUALIFICATION_ENVIRONMENT_ID",
    "NATIVE_QUALIFICATION_AUTHORITY_RECEIPT_SHA256", "NATIVE_QUALIFICATION_IMAGE_DIGEST", "NATIVE_QUALIFICATION_HELPER_SHA256",
    "NATIVE_QUALIFICATION_POLICY_SHA256"]);
  if (!isQualificationEnvironment(env) || Object.keys(values).some(key => values[key] !== undefined && !allowed.has(key))) throw denied();
  const secret = values.INTERNAL_RUNTIME_EVENT_SECRET;
  if (typeof secret !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(secret)) throw denied();
  return freezeQualification({
    subject: QualificationControlPropsSchema.parse({ purpose: "native_boundary_qualification",
      operatorAccountId: values.NATIVE_QUALIFICATION_OPERATOR_ACCOUNT_ID,
      controlPrincipal: values.NATIVE_QUALIFICATION_CONTROL_PRINCIPAL,
      environmentId: values.NATIVE_QUALIFICATION_ENVIRONMENT_ID,
      authorityReceiptSha256: values.NATIVE_QUALIFICATION_AUTHORITY_RECEIPT_SHA256,
    }),
    pins: QualificationPinsSchema.parse({ imageDigest: values.NATIVE_QUALIFICATION_IMAGE_DIGEST,
      helperSha256: values.NATIVE_QUALIFICATION_HELPER_SHA256, policySha256: values.NATIVE_QUALIFICATION_POLICY_SHA256 }),
    secret,
  });
}
export function authorizeQualification(env: Env, value: QualificationAuthorization): QualificationPolicy {
  const policy = qualificationPolicy(env);
  const props = QualificationControlPropsSchema.parse(value.props);
  if (!constantTimeQualificationEqual(policy.secret, value.secret) ||
    Object.keys(policy.subject).some(key => props[key as keyof QualificationControlProps] !== policy.subject[key as keyof QualificationControlProps])) throw denied();
  return policy;
}
export function qualificationRequestAuthorization(env: Env, request: Request, injectedProps: unknown): QualificationAuthorization {
  // These props are injected by the provider-owned service binding. Neither a
  // header/body identity nor knowledge of the internal secret can replace them.
  const props = QualificationControlPropsSchema.parse(injectedProps);
  const authorization = freezeQualification({ props,
    secret: request.headers.get("X-Internal-Runtime-Secret") ?? "",
    bearer: request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "",
  });
  authorizeQualification(env, authorization);
  return authorization;
}
export function constantTimeQualificationEqual(left: string, right: string): boolean {
  if (left.length > 256 || right.length > 256) return false;
  let difference = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) difference |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  return difference === 0;
}
function denied(): Error { return new Error("NATIVE_QUALIFICATION_AUTHORITY_UNAVAILABLE"); }
