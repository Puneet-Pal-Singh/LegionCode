/**
 * Provider Audit Log Interface
 *
 * Focused interface for append-only BYOK audit trail.
 */

import type { ProviderId } from "@repo/shared-types";
import type { BYOKValidationMode } from "@repo/shared-types";

export interface ProviderAuditEvent {
  eventType:
    | "connect"
    | "validate"
    | "disconnect"
    | "preferences"
    | "resolution_failure";
  status: "success" | "failure";
  providerId?: ProviderId;
  credentialId?: string;
  errorCode?: string;
  validationMode?: BYOKValidationMode;
  message?: string;
  metadataJson?: string;
}

export interface ProviderAuditLog {
  /**
   * Append an audit event
   */
  appendAuditEvent(event: ProviderAuditEvent): Promise<void>;
}
