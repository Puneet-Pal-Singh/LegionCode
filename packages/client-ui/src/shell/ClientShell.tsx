import type { ReactNode } from "react";

export function ClientShell({ children }: { children: ReactNode }) {
  return <div className="lc-client-shell">{children}</div>;
}
