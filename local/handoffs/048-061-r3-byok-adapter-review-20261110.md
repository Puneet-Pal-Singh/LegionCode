# R3 BYOK conflict adapter — review only

Source review base: `c33ca811b04117843563828489fae32b83fb5d90`.
Runtime-side preimage for the vault hunk: published `2b193c7334676bef7782b74eaff4c09571112316` (same vault bytes as integration premerge `64b3e6fae8bdf0e9db3b40f4ad9da3d2cc2e12b5`).
Incoming canonical extraction: `01585ca9ef520cd4aa153df5d70b680ecb3c0bed`.

This commit contains review text only. Neither adapter is applied to source. It does not restore an older whole vault or the deleted Brain model-discovery implementation. It adds no model/credential store, readiness boolean, native account proof, pin change or provider call.

## 1. CloudCredentialVault conflict hunk

Preserve the landed `resolveCredential(providerId)` interface. In the runtime integration, project its key/config pair from the already implemented fenced `resolveRuntimeCredential` acquisition. The existing acquisition honors the selected credential ID and validates its exact owner generation and token-material version. The projection exposes neither those private fields nor refresh material. Preserve all unrelated incoming BYOK methods and the canonical existing store.

The following exact hunk is against the runtime-side preimage above; it is a merge-resolution proposal, not a patch to apply wholesale to the review base:

```diff
--- a/apps/brain/src/services/providers/CloudCredentialVault.ts
+++ b/apps/brain/src/services/providers/CloudCredentialVault.ts
@@ -91,8 +91,19 @@
       tokenMaterialVersion: record.tokenMaterialVersion,
     };
   }
+  /** Discovery projects key and configuration from the existing fenced acquisition. */
+  async resolveCredential(providerId: ProviderId): Promise<{
+    apiKey: string;
+    connectionConfig?: ProviderConnectionConfig;
+  } | null> {
+    const credential = await this.resolveRuntimeCredential(providerId);
+    return credential ? {
+      apiKey: credential.apiKey,
+      ...(credential.connectionConfig ? { connectionConfig: credential.connectionConfig } : {}),
+    } : null;
+  }
   async getApiKey(providerId: ProviderId): Promise<string | null> {
-    return (await this.resolveRuntimeCredential(providerId))?.apiKey ?? null;
+    return (await this.resolveCredential(providerId))?.apiKey ?? null;
   }
   async getConnectionConfig(
     providerId: ProviderId,
```

## 2. Shared discovery conflict resolution

Keep the complete reviewed server-only `packages/provider-core/src/discovery/ProviderModelDiscoveryService.ts` from `01585ca9ef520cd4aa153df5d70b680ecb3c0bed`. Do not restore `apps/brain/src/services/providers/model-discovery/ProviderModelDiscoveryService.ts`. No algorithm change is proposed relative to the landed extraction. The old runtime-side call sites resolve to its already-landed interface as follows:

```diff
-const candidate = await this.credentialService.getConnectionConfig(providerId);
+const candidate = (await this.credentialService.resolveCredential(providerId))?.connectionConfig;

-const credential = await this.credentialService.resolveRuntimeCredential(providerId);
+const credential = await this.credentialService.resolveCredential(providerId);
 apiKey = credential?.apiKey ?? null;
 connectionConfig = credential?.connectionConfig;
```

The second replacement applies to both existing discovery request paths. Each request receives its key and configuration together from one canonical acquisition. No split key/config lookup, default-account fallback, second vault, provider-account ID assertion or entitlement claim is introduced.

## Integration and ownership

These are the two conflict resolutions requested for BYOK-owner review. The provider-core algorithm remains the exact landed owner implementation; the vault hunk only adapts its interface to the runtime's existing selected-record authority. No other peer-owned path is part of this review commit.

The finite integration remains uncommitted pending this review and the separately granted generic construction/user-input hunks. PR666 and other owner PRs are unchanged. This artifact is not compile/apply-ready source and has no production build claim.

## Execution and handoff receipt

Verified Linux host `8575502e05f6`, isolated review worktree at the exact source base above. Original approved handoff `37d5a77548669d1661b2cf2db26314cc7213adb7`: manifest SHA256 `feed0cce8426da047dc5683ec0d61cbdc605888f5cee3ab1caec72727e8d5326`, all 19 document hashes and byte lengths verified from exact Git objects. Later capability-ledger edits are retained and are not overwritten with historical bytes.
