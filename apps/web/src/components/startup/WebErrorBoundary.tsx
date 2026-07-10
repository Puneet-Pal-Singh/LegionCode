import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportWebException } from "../../lib/web-error-reporter";

interface WebErrorBoundaryProps {
  children: ReactNode;
}

interface WebErrorBoundaryState {
  failed: boolean;
}

/** Captures render and uncaught browser failures at the web-client boundary. */
export class WebErrorBoundary extends Component<
  WebErrorBoundaryProps,
  WebErrorBoundaryState
> {
  state: WebErrorBoundaryState = { failed: false };

  componentDidMount(): void {
    window.addEventListener("error", this.handleWindowError);
    window.addEventListener(
      "unhandledrejection",
      this.handleUnhandledRejection,
    );
  }

  componentWillUnmount(): void {
    window.removeEventListener("error", this.handleWindowError);
    window.removeEventListener(
      "unhandledrejection",
      this.handleUnhandledRejection,
    );
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    reportWebException("ui.render.failed", error, {
      componentStack: errorInfo.componentStack,
    });
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <main className="flex h-screen w-screen flex-col items-center justify-center gap-3 bg-black px-6 text-center text-zinc-100">
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="max-w-md text-sm text-zinc-400">
            The failure was recorded for investigation.
          </p>
          <button
            className="rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-950"
            onClick={() => window.location.reload()}
            type="button"
          >
            Reload LegionCode
          </button>
        </main>
      );
    }

    return this.props.children;
  }

  private readonly handleWindowError = (event: ErrorEvent): void => {
    reportWebException("ui.window-error", event.error ?? event.message, {
      filename: event.filename,
      line: event.lineno,
      column: event.colno,
    });
  };

  private readonly handleUnhandledRejection = (
    event: PromiseRejectionEvent,
  ): void => {
    reportWebException("ui.unhandled-rejection", event.reason);
  };

  static getDerivedStateFromError(): WebErrorBoundaryState {
    return { failed: true };
  }
}
