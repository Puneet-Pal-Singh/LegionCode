export interface ArtifactOpenOptions {
  refreshFromWorkspace?: boolean;
  startingLineNumber?: number;
}

export type ArtifactOpenHandler = (
  path: string,
  content: string,
  options?: ArtifactOpenOptions,
) => void;
