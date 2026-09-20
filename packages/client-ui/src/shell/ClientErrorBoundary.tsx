import { Component, type ErrorInfo, type ReactNode } from "react";

export type ClientErrorReport =
  | {
      source: "render";
      error: Error;
      componentStack: string;
    }
  | {
      source: "window";
      error: unknown;
      filename: string;
      line: number;
      column: number;
    }
  | {
      source: "unhandled-rejection";
      error: unknown;
    };

interface ClientErrorBoundaryProps {
  children: ReactNode;
  onError?: (report: ClientErrorReport) => void;
}

interface ClientErrorBoundaryState {
  failed: boolean;
}

export class ClientErrorBoundary extends Component<
  ClientErrorBoundaryProps,
  ClientErrorBoundaryState
> {
  state: ClientErrorBoundaryState = { failed: false };

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
    this.props.onError?.({
      source: "render",
      error,
      componentStack: errorInfo.componentStack ?? "",
    });
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <main className="lc-client-screen lc-client-error">
          <h1>Something went wrong</h1>
          <p>The failure was recorded for investigation.</p>
          <button onClick={() => window.location.reload()} type="button">
            Reload LegionCode
          </button>
        </main>
      );
    }

    return this.props.children;
  }

  private readonly handleWindowError = (event: ErrorEvent): void => {
    this.props.onError?.({
      source: "window",
      error: event.error ?? event.message,
      filename: event.filename,
      line: event.lineno,
      column: event.colno,
    });
  };

  private readonly handleUnhandledRejection = (
    event: PromiseRejectionEvent,
  ): void => {
    this.props.onError?.({
      source: "unhandled-rejection",
      error: event.reason,
    });
  };

  static getDerivedStateFromError(): ClientErrorBoundaryState {
    return { failed: true };
  }
}
