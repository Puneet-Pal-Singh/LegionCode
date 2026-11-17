import { join } from "node:path";
import { inspectNativeFileHelper, nativeHelperSources } from "./build-file-helper.mjs";
import { nativePackageCommand } from "./native-package-command.mjs";

/** Seal only caller-owned build output, without certificate discovery or a Developer ID.
 * Native PKG staging and archive production share the same preview content policy.
 * The caller retains its original output whenever command closure is uncertain.
 */
export async function sealUnsignedMacApp(appPath, ownership, platform = process.platform, architecture = process.arch) {
  if (platform !== "darwin") throw new Error("Unsigned Mac sealing requires Darwin");
  for (const { name } of nativeHelperSources) {
    const helper = join(appPath, "Contents", "Resources", "native", name);
    await inspectNativeFileHelper(helper, platform, architecture);
    await nativePackageCommand("/usr/bin/codesign", ["--force", "--sign", "-", "--options", "0", "--timestamp=none", helper], ownership);
  }
  // Preserve the existing unsigned PKG policy: no hardened-runtime library checks.
  await nativePackageCommand("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--options", "0",
    "--timestamp=none", "--preserve-metadata=entitlements", appPath], ownership, 120_000);
  await nativePackageCommand("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], ownership);
}
