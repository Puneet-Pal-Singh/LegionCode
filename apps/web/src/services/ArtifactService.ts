import { getMuscleHttpBase } from "../lib/platform-endpoints";
import type { ArtifactData } from "../types/chat";

/**
 * ArtifactService
 * Manages artifact state and tool call processing
 * Single Responsibility: Handle artifacts only
 */
export class ArtifactService {
  private artifact: ArtifactData | null = null;
  private isArtifactOpen = false;
  private onArtifactCreatedCallback: (() => void) | undefined;

  constructor(onArtifactCreated?: () => void) {
    this.onArtifactCreatedCallback = onArtifactCreated;
  }

  /**
   * Process tool call and extract artifact if present
   */
  processToolCall(toolName: string, args: Record<string, unknown>): void {
    if (toolName === "create_code_artifact") {
      const artifactData = this.validateArtifactData(args);
      if (artifactData) {
        this.setArtifact(artifactData);
        this.onArtifactCreatedCallback?.();
      }
    }
  }

  /**
   * Validate artifact data shape
   */
  private validateArtifactData(data: unknown): ArtifactData | null {
    if (
      typeof data !== "object" ||
      data === null ||
      !("path" in data) ||
      !("content" in data)
    ) {
      return null;
    }

    const { path, content } = data as Record<string, unknown>;

    if (typeof path !== "string" || typeof content !== "string") {
      return null;
    }

    return { path, content };
  }

  getArtifact(): ArtifactData | null {
    return this.artifact;
  }

  setArtifact(artifact: ArtifactData | null): void {
    this.artifact = artifact;
  }

  isOpen(): boolean {
    return this.isArtifactOpen;
  }

  setIsOpen(isOpen: boolean): void {
    this.isArtifactOpen = isOpen;
  }
}

/** Existing cold-storage transport, supplied to the shared artifact renderer. */
export async function loadColdStorageArtifact(key: string): Promise<string> {
  const res = await fetch(`${getMuscleHttpBase()}/artifact?key=${encodeURIComponent(key)}`);
  if (!res.ok) {
    throw new Error(`Artifact fetch failed: ${res.status}`);
  }
  return res.text();
}
