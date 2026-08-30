import {
  DEFAULT_PRODUCT_MODE,
  PRODUCT_MODES,
  type ProductMode,
} from "@repo/shared-types";

const PRODUCT_MODE_STORAGE_KEY_PREFIX = "legioncode:product-mode:";

export function loadStoredProductMode(sessionId: string): ProductMode {
  if (typeof window === "undefined") {
    return DEFAULT_PRODUCT_MODE;
  }

  try {
    const stored = window.localStorage.getItem(
      `${PRODUCT_MODE_STORAGE_KEY_PREFIX}${sessionId}`,
    );
    return isProductMode(stored) ? stored : DEFAULT_PRODUCT_MODE;
  } catch {
    return DEFAULT_PRODUCT_MODE;
  }
}

export function persistProductMode(
  sessionId: string,
  productMode: ProductMode,
): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      `${PRODUCT_MODE_STORAGE_KEY_PREFIX}${sessionId}`,
      productMode,
    );
  } catch {
    // Ignore storage failures and keep in-memory selection.
  }
}

function isProductMode(value: unknown): value is ProductMode {
  return (
    value === PRODUCT_MODES.ASK_ALWAYS ||
    value === PRODUCT_MODES.AUTO_FOR_SAFE ||
    value === PRODUCT_MODES.AUTO_FOR_SAME_REPO ||
    value === PRODUCT_MODES.FULL_AGENT
  );
}
