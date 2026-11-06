import type { NativeFileHelperDiagnostics } from "./build-file-helper.mjs";
export function verifyBundledProcessHelper(
  executablePath: string,
  platform: string,
  architecture: string,
): Promise<NativeFileHelperDiagnostics & { protocol: "guardian-fd6-v1" }>;
