export interface TitleProjectionVersion {
  titleSource?: string;
  titleVersion?: number;
  updatedAt: string;
}

/** Existing read-merge ordering: user ownership and newer server versions win. */
export function shouldRetainCurrentTitleProjection(
  current: TitleProjectionVersion,
  incoming: TitleProjectionVersion,
): boolean {
  if (current.titleSource === "user" && incoming.titleSource !== "user") {
    return true;
  }

  const currentVersion = current.titleVersion;
  const incomingVersion = incoming.titleVersion;
  if (incomingVersion !== undefined && currentVersion === undefined) {
    return false;
  }
  if (currentVersion !== undefined && incomingVersion !== undefined) {
    return currentVersion > incomingVersion;
  }

  return current.updatedAt > incoming.updatedAt;
}
