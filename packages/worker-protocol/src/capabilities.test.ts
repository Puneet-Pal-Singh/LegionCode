import { describe, expect, it } from "vitest";
import { WORKER_OPERATION_NAMES } from "./common.js";
import { WorkerCapabilitySnapshotSchema } from "./capabilities.js";

const capturedAt = "2026-06-08T15:00:00.000Z";

describe("worker capability schemas", () => {
  it("represents a cloud worker capability snapshot", () => {
    const capability = WorkerCapabilitySnapshotSchema.parse({
      workerId: "worker_cloud123",
      workerKind: "cloud",
      backendKind: "cloud_sandbox",
      version: "1.0.0",
      supportsShell: true,
      supportsGit: true,
      supportsSnapshots: true,
      supportsBrowser: false,
      supportsLongRunningProcesses: true,
      supportsNetworkEgress: true,
      maxRuntimeSeconds: 900,
      maxWorkspaceBytes: 1_000_000_000,
      isolationStrength: "sandbox",
      supportedLanguages: ["node", "python"],
      artifactStoreKind: "r2",
      supportedOperations: WORKER_OPERATION_NAMES,
      capturedAt,
    });

    expect(capability.workerKind).toBe("cloud");
    expect(capability.backendKind).toBe("cloud_sandbox");
  });

  it("represents a local worker capability snapshot", () => {
    const capability = WorkerCapabilitySnapshotSchema.parse({
      workerId: "worker_local123",
      workerKind: "local",
      backendKind: "local_cli",
      version: "1.0.0",
      supportsShell: true,
      supportsGit: true,
      supportsSnapshots: false,
      supportsBrowser: true,
      supportsLongRunningProcesses: true,
      supportsNetworkEgress: false,
      maxRuntimeSeconds: 3_600,
      maxWorkspaceBytes: 10_000_000_000,
      isolationStrength: "process",
      supportedLanguages: ["node"],
      artifactStoreKind: "local_blob",
      supportedOperations: [
        "worker.capabilities",
        "command.run",
        "file.read",
        "file.write",
        "patch.apply",
        "git.status",
      ],
      capturedAt,
    });

    expect(capability.workerKind).toBe("local");
    expect(capability.supportsNetworkEgress).toBe(false);
  });

  it("rejects duplicate negotiated operations", () => {
    expect(() =>
      WorkerCapabilitySnapshotSchema.parse({
        workerId: "worker_dupe123",
        workerKind: "self_hosted",
        backendKind: "self_hosted",
        version: "1.0.0",
        supportsShell: true,
        supportsGit: true,
        supportsSnapshots: false,
        supportsBrowser: false,
        supportsLongRunningProcesses: false,
        supportsNetworkEgress: true,
        maxRuntimeSeconds: 600,
        maxWorkspaceBytes: 500_000_000,
        isolationStrength: "container",
        supportedLanguages: ["node"],
        artifactStoreKind: "worker_blob",
        supportedOperations: ["worker.capabilities", "worker.capabilities"],
        capturedAt,
      }),
    ).toThrow();
  });
});
