import { useEffect, useState } from "react";
import type { AppServerEnvironmentSnapshot } from "@repo/platform-protocol";
import type { DesktopApi, DesktopBuildInfo } from "../../shared/desktop-api";

/** Bootstrap reads may not overwrite a newer environment notification. */
export function useDesktopEnvironment(desktop: Pick<
  DesktopApi,
  "getBuildInfo" | "getEnvironment" | "onEnvironmentStatus"
>) {
  const [build, setBuild] = useState<DesktopBuildInfo | null>(null);
  const [environment, setEnvironment] = useState<AppServerEnvironmentSnapshot | null>(null);
  const [buildError, setBuildError] = useState<Error | null>(null);
  const [environmentError, setEnvironmentError] = useState<Error | null>(null);

  useEffect(() => {
    let active = true;
    let notified = false;
    const unsubscribe = desktop.onEnvironmentStatus((snapshot) => {
      if (!active) return;
      notified = true;
      setEnvironmentError(null);
      setEnvironment(snapshot);
    });
    void desktop.getBuildInfo().then((info) => {
      if (active) setBuild(info);
    }).catch(() => {
      if (active) setBuildError(new Error("Desktop build information could not be loaded."));
    });
    void desktop.getEnvironment().then((snapshot) => {
      if (active && !notified) setEnvironment(snapshot);
    }).catch(() => {
      if (active && !notified) {
        setEnvironmentError(new Error("Desktop environment status could not be loaded."));
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [desktop]);

  return { build, environment, error: buildError ?? environmentError };
}
