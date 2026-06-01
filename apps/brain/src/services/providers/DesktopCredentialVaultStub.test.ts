import { describe, expect, it } from "vitest";
import { DesktopCredentialVaultStub } from "./DesktopCredentialVaultStub";

describe("DesktopCredentialVaultStub", () => {
  it("fails fast for unsupported desktop credential operations", async () => {
    const vault = new DesktopCredentialVaultStub();

    await expect(
      vault.setCredential("openai", "sk-desktop-test-1234567890"),
    ).rejects.toThrow('not supported on "desktop"');
    await expect(vault.getApiKey("openai")).rejects.toThrow(
      'not supported on "desktop"',
    );
    await expect(vault.getConnectionConfig("openai")).rejects.toThrow(
      'not supported on "desktop"',
    );
    await expect(vault.listConnectedProviders()).rejects.toThrow(
      'not supported on "desktop"',
    );
  });
});
