import { ClientErrorBoundary } from "@legioncode/client-ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DesktopLocalWorkspace } from "./DesktopLocalWorkspace";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Desktop renderer root is missing");
}

createRoot(root).render(
  <StrictMode>
    <ClientErrorBoundary>
      <DesktopLocalWorkspace />
    </ClientErrorBoundary>
  </StrictMode>,
);
