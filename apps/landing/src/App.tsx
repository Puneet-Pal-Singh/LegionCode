import { useEffect } from "react";
import { CloudReservedPage, LandingPage } from "./LandingPage";
import {
  buildAgentsRedirectUrl,
  resolveLandingRoute,
} from "./lib/landing-route";

function RedirectToAgents({ target }: { target: string }) {
  useEffect(() => {
    window.location.replace(target);
  }, [target]);

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-black text-sm text-zinc-500">
      Opening LegionCode agents...
    </div>
  );
}

export default function App() {
  const route = resolveLandingRoute(window.location.pathname);

  if (route.kind === "cloud") {
    return <CloudReservedPage />;
  }

  if (route.kind === "redirect") {
    return (
      <RedirectToAgents
        target={buildAgentsRedirectUrl(
          window.location.search,
          window.location.hash,
        )}
      />
    );
  }

  return <LandingPage />;
}
