"use client";

import { useSearchParams } from "next/navigation";
import { ShieldAlert } from "lucide-react";

export default function PendingAccessNotice() {
  const searchParams = useSearchParams();

  if (searchParams.get("access") !== "pending") {
    return null;
  }

  return (
    <div
      role="status"
      className="mb-5 flex w-full items-start gap-3 rounded-lg border border-amber-300/20 bg-amber-300/[0.06] px-4 py-3 text-left"
    >
      <ShieldAlert
        className="mt-0.5 h-4 w-4 shrink-0 text-amber-200"
        aria-hidden="true"
      />
      <div>
        <p className="font-mono text-xs font-medium text-amber-100">
          This GitHub account does not have access yet.
        </p>
        <p className="mt-1 font-mono text-[11px] leading-relaxed text-zinc-400">
          Request access below using the email associated with your GitHub
          account.
        </p>
      </div>
    </div>
  );
}
