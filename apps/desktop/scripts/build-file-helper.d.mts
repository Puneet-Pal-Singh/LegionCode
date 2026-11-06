export const minimumMacOSVersion: string;
export function verifyPackagedMacOSMinimum(
  infoPlistPath: string,
): Promise<void>;
export type NativeFileHelperDiagnostics = {
  platform: string;
  architecture: string;
  sha256: string;
  minimumMacOSVersion?: string;
};
export function assertNativeFileHelperTarget(
  platform: string,
  architecture: string,
): void;
export function inspectNativeFileHelper(
  path: string,
  platform: string,
  architecture: string,
): Promise<NativeFileHelperDiagnostics>;
export function buildNativeFileHelper(
  sourcePath: string,
  platform: string,
  architecture: string,
): Promise<NativeFileHelperDiagnostics & { sourceSha256: string }>;
export function verifyBundledFileHelper(
  executablePath: string,
  platform: string,
  architecture: string,
): Promise<NativeFileHelperDiagnostics & { protocol: "LCFM/1" }>;
