/**
 * Keeps protocol-safe tool-call ids internal while preserving the exact id
 * required by the provider transcript.
 */
export class ProviderToolCallIdentityMap {
  private readonly providerIdsByProtocolId = new Map<string, string>();

  register(protocolToolCallId: string, providerToolCallId: string): void {
    this.providerIdsByProtocolId.set(protocolToolCallId, providerToolCallId);
  }

  toProviderId(protocolToolCallId: string): string {
    return (
      this.providerIdsByProtocolId.get(protocolToolCallId) ??
      protocolToolCallId
    );
  }
}
