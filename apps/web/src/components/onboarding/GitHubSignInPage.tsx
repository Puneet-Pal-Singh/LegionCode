import { Github, ShieldCheck } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";

interface GitHubSignInPageProps {
  onLogin: () => void;
}

export function GitHubSignInPage({ onLogin }: GitHubSignInPageProps) {
  const reduceMotion = useReducedMotion();

  return (
    <main className="relative flex h-screen w-screen items-center justify-center overflow-hidden bg-[#090a0c] px-6 text-[#f2f4f7]">
      <div className="absolute inset-x-0 top-0 h-px bg-[#282c34]" />
      <div className="absolute right-6 top-6 font-mono text-[10px] uppercase tracking-[0.18em] text-[#969daa]">
        Private alpha
      </div>

      <motion.section
        initial={reduceMotion ? false : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        aria-labelledby="sign-in-title"
        className="w-full max-w-[420px] -translate-y-6"
      >
        <div className="mb-10 flex items-center gap-3">
          <div className="grid h-8 w-8 place-items-center border border-[#3a404a] bg-[#111318] font-mono text-xs font-semibold text-white">
            LC
          </div>
          <span className="text-sm font-semibold tracking-tight">LegionCode</span>
        </div>

        <h1
          id="sign-in-title"
          className="max-w-sm text-[28px] font-medium leading-[34px] tracking-[-0.025em]"
        >
          Give an agent a repository. Review the result.
        </h1>
        <p className="mt-4 text-sm leading-6 text-[#969daa]">
          Sign in to the private alpha and choose where LegionCode should work.
        </p>

        <button
          type="button"
          onClick={onLogin}
          className="mt-8 flex min-h-12 w-full items-center justify-center gap-3 rounded-lg bg-[#f2f4f7] px-4 text-sm font-semibold text-[#090a0c] transition hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#65b8ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#090a0c]"
        >
          <Github size={18} aria-hidden="true" />
          Continue with GitHub
        </button>

        <div className="mt-5 flex items-start gap-2 text-xs leading-5 text-[#969daa]">
          <ShieldCheck className="mt-0.5 shrink-0 text-[#47d18c]" size={14} />
          <p>You choose which repositories LegionCode can access.</p>
        </div>

        <nav aria-label="Legal" className="mt-12 flex gap-4 text-xs text-[#969daa]">
          <a className="hover:text-white focus-visible:text-white" href="/terms">
            Terms
          </a>
          <a className="hover:text-white focus-visible:text-white" href="/privacy">
            Privacy
          </a>
        </nav>
      </motion.section>
    </main>
  );
}
