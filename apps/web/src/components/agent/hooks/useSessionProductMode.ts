import { useCallback, useEffect, useState } from "react";
import { DEFAULT_PRODUCT_MODE, type ProductMode } from "@repo/shared-types";
import {
  loadStoredProductMode,
  persistProductMode,
} from "../../../lib/product-mode-storage";

/** One mounted session owner, with an explicit setup-to-conversation handoff. */
export function useSessionProductMode(
  sessionId: string | undefined,
  initialMode?: ProductMode,
) {
  const createSelection = () => ({
    sessionId,
    productMode: initialMode ?? (sessionId ? loadStoredProductMode(sessionId) : DEFAULT_PRODUCT_MODE),
    initialMode,
  });
  const [selection, setSelection] = useState(createSelection);
  let current = selection;
  if (selection.sessionId !== sessionId ||
    (initialMode !== undefined && selection.initialMode !== initialMode)) {
    // Apply a newly handed-off choice before any child can submit its prompt.
    // An effect would leave one commit using the previous/default permission.
    current = createSelection();
    setSelection(current);
  }
  const productMode = current.productMode;
  useEffect(() => {
    if (sessionId && initialMode !== undefined) {
      persistProductMode(sessionId, initialMode);
    }
  }, [initialMode, sessionId]);
  const setProductMode = useCallback((mode: ProductMode) => {
    setSelection({ sessionId, productMode: mode, initialMode });
    if (sessionId) persistProductMode(sessionId, mode);
  }, [initialMode, sessionId]);

  return { productMode, setProductMode };
}
