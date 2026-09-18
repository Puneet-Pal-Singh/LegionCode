import {
  ClientErrorBoundary,
  type ClientErrorReport,
} from "@legioncode/client-ui";
import type { ReactNode } from "react";
import { reportWebException } from "../../lib/web-error-reporter";

interface WebErrorBoundaryProps {
  children: ReactNode;
}

/** Captures render and uncaught browser failures at the web-client boundary. */
export function WebErrorBoundary({ children }: WebErrorBoundaryProps) {
  return (
    <ClientErrorBoundary onError={reportClientError}>
      {children}
    </ClientErrorBoundary>
  );
}

function reportClientError(report: ClientErrorReport): void {
  if (report.source === "render") {
    reportWebException("ui.render.failed", report.error, {
      componentStack: report.componentStack,
    });
    return;
  }

  if (report.source === "window") {
    reportWebException("ui.window-error", report.error, {
      filename: report.filename,
      line: report.line,
      column: report.column,
    });
    return;
  }

  reportWebException("ui.unhandled-rejection", report.error);
}
