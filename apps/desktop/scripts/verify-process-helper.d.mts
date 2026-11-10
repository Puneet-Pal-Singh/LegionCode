import type { NativeFileHelperDiagnostics } from "./build-file-helper.mjs";
export function verifyBundledProcessHelper(
  executablePath: string,
  platform: string,
  architecture: string,
): Promise<NativeFileHelperDiagnostics & {
  protocol: "guardian-fd6-v2";
  intentProbe: {
    v: 2;
    event: "intent_probe";
    state: "supported";
    intentVersion: 1;
  };
}>;
