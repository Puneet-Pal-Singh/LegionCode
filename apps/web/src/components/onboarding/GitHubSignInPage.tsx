import { Github } from "lucide-react";
import { LegionCodeMark } from "../brand/LegionCodeMark";

interface GitHubSignInPageProps {
  onLogin: () => void;
}

export function GitHubSignInPage({ onLogin }: GitHubSignInPageProps) {
  return (
    <main className="flex min-h-screen w-full items-center justify-center bg-background px-5 py-10 text-text-primary">
      <section
        aria-labelledby="sign-in-title"
        className="w-full max-w-[440px] rounded-2xl border border-border-subtle bg-surface px-8 py-10 shadow-[0_24px_70px_rgba(0,0,0,0.4)] sm:px-11 sm:py-11"
      >
        <div
          role="img"
          aria-label="LegionCode"
          className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl border border-white/15 bg-white/[0.07] text-white shadow-2xl backdrop-blur-xl"
        >
          <LegionCodeMark className="h-9 w-9" />
        </div>

        <h1
          id="sign-in-title"
          className="mt-8 text-center text-[32px] font-semibold leading-[38px] tracking-[-0.04em]"
        >
          Sign in to LegionCode
        </h1>
        <p className="mx-auto mt-2.5 max-w-[320px] text-center text-[15px] leading-6 text-text-secondary">
          Brainstorm in Chat. Build in Cloud.
        </p>

        <button
          type="button"
          onClick={onLogin}
          className="mt-8 flex min-h-12 w-full items-center justify-center gap-2.5 rounded-xl bg-zinc-100 px-4 text-[14px] font-semibold text-zinc-950 transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        >
          <Github size={18} strokeWidth={2.2} aria-hidden="true" />
          Continue with GitHub
        </button>
      </section>
    </main>
  );
}
