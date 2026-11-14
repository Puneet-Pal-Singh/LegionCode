import { useDesktopHostedAccount, type DesktopHostedAccountControls } from "./useDesktopHostedAccount";

/** Account connection only; local providers and active attempts are untouched. */
export function DesktopHostedAccount({ controls }: { controls?: DesktopHostedAccountControls }): React.JSX.Element {
  return controls ? <HostedAccountView {...controls} /> : <OwnedHostedAccount />;
}

function OwnedHostedAccount() {
  return <HostedAccountView {...useDesktopHostedAccount()} />;
}

function HostedAccountView({ snapshot, busy, error, perform }: DesktopHostedAccountControls): React.JSX.Element {
  const signedIn = snapshot?.state === "signed_in";
  const signOutFailed = snapshot?.state === "sign_out_failed";
  return (
    <div className="ui-surface-section px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-100">LegionCode account</p>
          <p className="mt-1 text-sm text-zinc-400" role="status">
            {busy ? "Checking account…" : signedIn ? `Signed in as ${snapshot.account?.login}`
              : signOutFailed ? "Sign-out could not be confirmed. Retry to revoke the hosted session."
                : snapshot?.state === "unavailable" ? "Hosted service is unavailable."
                : "Sign in to your hosted LegionCode account."}
          </p>
          <p className="mt-1 text-xs text-zinc-500">Local projects and provider keys stay on this computer.</p>
        </div>
        <button type="button" disabled={busy} onClick={() => void perform(signedIn || signOutFailed ? "disconnect" : "connect")}
          className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-50">
          {signOutFailed ? "Retry sign out" : signedIn ? "Sign out" : "Sign in"}
        </button>
      </div>
      {error ? <p role="alert" className="mt-2 text-sm text-red-300">{error}</p> : null}
    </div>
  );
}
