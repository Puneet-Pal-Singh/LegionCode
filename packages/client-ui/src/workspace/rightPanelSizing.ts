const DEFAULT_LEFT_SIDEBAR_WIDTH = 320;
const MIN_INITIAL_RIGHT_SIDEBAR_WIDTH = 420;
const MIN_RIGHT_SIDEBAR_WIDTH = 320;
const MAX_RIGHT_SIDEBAR_WIDTH = 720;

/** Existing Web initial sizing, before an explicit user resize. */
export function getInitialRightSidebarWidth(viewportWidth: number): number {
  const availableWidth = viewportWidth - DEFAULT_LEFT_SIDEBAR_WIDTH;
  return Math.max(
    MIN_INITIAL_RIGHT_SIDEBAR_WIDTH,
    Math.min(MAX_RIGHT_SIDEBAR_WIDTH, Math.round(availableWidth * 0.42)),
  );
}

/** Existing Web resize bounds deliberately allow a narrower rail than initial sizing. */
export function clampRightSidebarWidth(width: number): number {
  return Math.max(MIN_RIGHT_SIDEBAR_WIDTH, Math.min(MAX_RIGHT_SIDEBAR_WIDTH, width));
}
