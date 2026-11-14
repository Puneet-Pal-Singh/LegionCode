export const minimumMacOSVersion: string;
export const nativeHelperSources: ReadonlyArray<{
  name: string;
  sourcePath: string;
  additionalSourcePaths?: readonly string[];
}>;
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
export function hashNativeHelperCompilationUnit(
  sourcePath: string,
  platform: string,
  architecture: string,
  helperName?: string,
): Promise<string>;
export function inspectNativeFileHelper(
  path: string,
  platform: string,
  architecture: string,
): Promise<NativeFileHelperDiagnostics>;
export function buildNativeFileHelper(
  sourcePath: string,
  platform: string,
  architecture: string,
  helperName: string,
): Promise<NativeFileHelperDiagnostics & { sourceSha256: string }>;
export function verifyBundledFileHelper(
  executablePath: string,
  platform: string,
  architecture: string,
): Promise<NativeFileHelperDiagnostics & { protocol: "LCFM/1" }>;
export function verifyBundledHostBroker(
  executablePath: string,
  platform: string,
  architecture: string,
): Promise<NativeFileHelperDiagnostics & { definedWriterCallbacks: string[] }>;
