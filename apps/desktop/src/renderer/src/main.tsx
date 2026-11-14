import { ClientErrorBoundary } from "@legioncode/client-ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DesktopHost } from "./DesktopHost";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Desktop renderer root is missing");
}

createRoot(root).render(
  <StrictMode>
    <ClientErrorBoundary>
      <DesktopHost />
    </ClientErrorBoundary>
  </StrictMode>,
);
