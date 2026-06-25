import { Github, KeyRound, ShieldCheck } from "lucide-react";
import { motion } from "framer-motion";
import { GitHubLoginButton } from "../auth/GitHubLoginButton";

interface LockedShellCardProps {
  onLogin: () => void;
}

export function LockedShellCard({ onLogin }: LockedShellCardProps) {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="w-full max-w-xl rounded-3xl border border-zinc-800 bg-[#0f1012]/95 p-8 shadow-[0_24px_80px_rgba(0,0,0,0.45)]"
      >
        <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900 text-zinc-200">
          <Github size={22} />
        </div>

        <div className="space-y-3">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-300">
            Private alpha access
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            Sign in with your approved GitHub account
          </h1>
          <p className="text-sm leading-6 text-zinc-400">
            GitHub verifies your approved identity and provides repository
            access. Unapproved accounts return to the Cloud access page.
          </p>
        </div>

        <div className="mt-6 grid gap-3 text-sm text-zinc-300 sm:grid-cols-2">
          <InfoTile
            icon={Github}
            title="Pick your repository"
            description="After sign-in, select the repo you want LegionCode to work on."
          />
          <InfoTile
            icon={KeyRound}
            title="Set up your model provider"
            description="Add your API key provider after sign-in so you can choose models and run prompts."
          />
        </div>

        <div className="mt-8 flex items-center justify-between gap-4 border-t border-zinc-800 pt-6">
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <ShieldCheck size={14} className="text-emerald-400" />
            We enable repository and provider setup only after secure sign-in.
          </div>
          <GitHubLoginButton onClick={onLogin} size="lg" variant="primary" />
        </div>
      </motion.div>
    </div>
  );
}

function InfoTile({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-black/30 p-4">
      <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900 text-zinc-300">
        <Icon size={16} />
      </div>
      <h2 className="text-sm font-medium text-white">{title}</h2>
      <p className="mt-1 text-xs leading-5 text-zinc-500">{description}</p>
    </div>
  );
}
