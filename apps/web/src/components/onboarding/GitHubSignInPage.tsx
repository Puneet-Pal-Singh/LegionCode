import { Github } from "lucide-react";

interface GitHubSignInPageProps {
  onLogin: () => void;
}

export function GitHubSignInPage({ onLogin }: GitHubSignInPageProps) {
  return (
    <main className="flex min-h-screen w-full items-center justify-center bg-[#090a0c] px-5 py-10 text-[#f2f4f7]">
      <section
        aria-labelledby="sign-in-title"
        className="w-full max-w-[420px] rounded-[14px] border border-[#292d35] bg-[#111318] px-7 py-8 shadow-[0_16px_44px_rgba(0,0,0,0.22)] sm:px-9 sm:py-9"
      >
        <div
          aria-label="LegionCode"
          className="flex items-center justify-center gap-2.5"
        >
          <div className="grid h-9 w-9 place-items-center rounded-md border border-[#3a404a] bg-[#0b0c0f] font-mono text-[11px] font-semibold tracking-[-0.04em] text-white">
            LC
          </div>
          <span className="text-[15px] font-semibold tracking-[-0.02em]">
            LegionCode
          </span>
        </div>

        <h1
          id="sign-in-title"
          className="mt-7 text-center text-[25px] font-semibold leading-8 tracking-[-0.035em]"
        >
          Sign in to LegionCode
        </h1>
        <p className="mt-2 text-center text-sm leading-6 text-[#969daa]">
          Brainstorm in Chat. Build in Cloud.
        </p>

        <button
          type="button"
          onClick={onLogin}
          className="mt-7 flex min-h-11 w-full items-center justify-center gap-2.5 rounded-lg bg-[#f2f4f7] px-4 text-sm font-semibold text-[#090a0c] transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#65b8ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#111318]"
        >
          <Github size={17} strokeWidth={2.25} aria-hidden="true" />
          Continue with GitHub
        </button>

        <p className="mx-auto mt-5 max-w-[330px] text-center text-[11px] leading-[17px] text-[#777e8a]">
          By continuing, you agree to our{" "}
          <a
            className="whitespace-nowrap underline decoration-[#4d535d] underline-offset-2 transition-colors hover:text-[#c7cbd2] focus-visible:text-white focus-visible:outline-none"
            href="/terms"
          >
            Terms
          </a>{" "}
          and{" "}
          <a
            className="whitespace-nowrap underline decoration-[#4d535d] underline-offset-2 transition-colors hover:text-[#c7cbd2] focus-visible:text-white focus-visible:outline-none"
            href="/privacy"
          >
            Privacy Policy
          </a>
          .
        </p>
      </section>
    </main>
  );
}
