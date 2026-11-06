import type {
  HarnessSetupRequest, HarnessSetupResponse,
  HarnessStatusRequest, HarnessStatusResponse,
  HarnessModelsRequest, HarnessModelsResponse,
  HarnessSelectionReadRequest, HarnessSelectRequest, HarnessSelectionResponse,
} from "@repo/platform-protocol";

/** A placement composes its canonical connection/selection owner here.
 * Setup uses an authorized connection. Omitted instanceId requests creation;
 * a supplied ID reconnects that exact instance. The durable command receipt must
 * return the same persisted instance ID on retries, never a process identity.
 * Setup is not a raw provider RPC.
 * select must durably CAS expectedRevision and deduplicate clientCommandId.
 * A changed next selection never changes an admitted Run Attempt.
 */
export interface HarnessOperations {
  setup(params: HarnessSetupRequest): Promise<HarnessSetupResponse>;
  status(params: HarnessStatusRequest): Promise<HarnessStatusResponse>;
  models(params: HarnessModelsRequest): Promise<HarnessModelsResponse>;
  readSelection(params: HarnessSelectionReadRequest): Promise<HarnessSelectionResponse>;
  select(params: HarnessSelectRequest): Promise<HarnessSelectionResponse>;
}
