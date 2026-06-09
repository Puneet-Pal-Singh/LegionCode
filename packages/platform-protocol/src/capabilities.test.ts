import { describe, expect, it } from "vitest";
import {
  ModelCapabilitySnapshotSchema,
  ProviderCapabilitySnapshotSchema,
  WorkerCapabilitySnapshotSchema,
} from "./capabilities.js";

const capturedAt = "2026-06-09T12:00:00.000Z";

describe("provider and model capability snapshots", () => {
  it("represents unknown support explicitly", () => {
    const snapshot = ModelCapabilitySnapshotSchema.parse({
      providerId: "openai",
      modelId: "gpt-5",
      capabilities: [
        {
          key: "tool_calling",
          support: "unknown",
          source: "provider_discovery",
          confidence: "unknown",
        },
      ],
      contextWindowTokens: null,
      maxOutputTokens: null,
      capturedAt,
    });

    expect(snapshot.capabilities[0]?.support).toBe("unknown");
  });

  it("rejects duplicate capability keys", () => {
    expect(() =>
      ProviderCapabilitySnapshotSchema.parse({
        providerId: "openai",
        capabilities: [
          {
            key: "streaming",
            support: "supported",
            source: "static_registry",
            confidence: "authoritative",
          },
          {
            key: "streaming",
            support: "unknown",
            source: "runtime_probe",
            confidence: "unknown",
          },
        ],
        capturedAt,
      }),
    ).toThrow();
  });
});

describe("WorkerCapabilitySnapshotSchema", () => {
  it("parses worker differences as capability data", () => {
    const snapshot = WorkerCapabilitySnapshotSchema.parse({
      workerId: "worker_cloudflare01",
      workerKind: "cloudflare_sandbox",
      workerVersion: "1.0.0",
      executionLocation: "cloud_sandbox",
      supportsShell: true,
      supportsGit: true,
      supportsFileWrite: true,
      supportsSnapshots: true,
      supportsBrowser: false,
      supportsNetworkEgress: false,
      supportsLongRunningProcesses: false,
      maxRuntimeSeconds: 1800,
      maxWorkspaceBytes: 1_073_741_824,
      isolationStrength: "sandbox",
      supportedLanguages: ["typescript", "rust"],
      artifactStoreKind: "r2",
      capturedAt,
    });

    expect(snapshot.executionLocation).toBe("cloud_sandbox");
    expect(snapshot.supportsBrowser).toBe(false);
  });

  it("requires every worker capability instead of applying defaults", () => {
    expect(() =>
      WorkerCapabilitySnapshotSchema.parse({
        workerId: "worker_cloudflare01",
        workerKind: "cloudflare_sandbox",
        workerVersion: "1.0.0",
        executionLocation: "cloud_sandbox",
        capturedAt,
      }),
    ).toThrow();
  });
});
