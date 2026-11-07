/** Both hosts use this gate. No UID-only or SDK cwd/env fallback is permitted. */
export const CLOUD_HARNESS_AVAILABILITY = Object.freeze({
  available: false as const,
  code: "cloud_harness_confinement_unavailable" as const,
  sandboxSdk: "0.12.3",
  sandboxImage:
    "sha256:23f67e16131b780865a5fa5aa3c8607408a730105c248836409f4e02bb6bf042",
  missingCapabilities: [
    "descendant_filesystem_and_git_metadata_confinement",
    "privileged_control_plane_endpoint_isolation",
    "process_tree_and_background_work_quiescence_proof",
  ] as const,
});

export class CloudHarnessUnavailableError extends Error {
  readonly code = CLOUD_HARNESS_AVAILABILITY.code;
  constructor() {
    super(CLOUD_HARNESS_AVAILABILITY.code);
    this.name = "CloudHarnessUnavailableError";
  }
}

export function assertCloudHarnessLaunchAvailable(): void {
  throw new CloudHarnessUnavailableError();
}
