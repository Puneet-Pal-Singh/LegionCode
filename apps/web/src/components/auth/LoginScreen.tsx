import { motion } from "framer-motion";
import {
  FileCode,
  Github,
  KeyRound,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { GitHubLoginButton } from "./GitHubLoginButton";

interface LoginScreenProps {
  onLogin: () => void;
  onSkip?: () => void;
}

export function LoginScreen({ onLogin, onSkip }: LoginScreenProps) {
  return (
    <div className="h-screen w-screen bg-black flex items-center justify-center relative overflow-hidden">
      {/* Animated Background Elements */}
      <div className="absolute inset-0 pointer-events-none">
        <motion.div
          className="absolute top-1/4 left-1/4 w-64 h-64 bg-emerald-500/5 rounded-full blur-[100px]"
          animate={{
            scale: [1, 1.2, 1],
            opacity: [0.3, 0.5, 0.3],
          }}
          transition={{
            duration: 8,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />
        <motion.div
          className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-blue-500/5 rounded-full blur-[120px]"
          animate={{
            scale: [1.2, 1, 1.2],
            opacity: [0.2, 0.4, 0.2],
          }}
          transition={{
            duration: 10,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />

        {/* Floating Icons */}
        <FloatingIcon Icon={ShieldCheck} className="top-20 left-20" delay={0} />
        <FloatingIcon Icon={Terminal} className="top-32 right-32" delay={0.5} />
        <FloatingIcon Icon={FileCode} className="bottom-32 left-32" delay={1} />
        <FloatingIcon Icon={KeyRound} className="bottom-20 right-20" delay={1.5} />
      </div>

      {/* Main Content */}
      <motion.div
        className="relative z-10 flex flex-col items-center max-w-md mx-auto px-6"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        {/* Logo */}
        <motion.div
          className="mb-6"
          animate={{
            y: [0, -8, 0],
          }}
          transition={{
            duration: 4,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        >
          <img
            alt="LegionCode"
            className="h-10 w-auto"
            height="40"
            src="/assets/legioncode-wordmark.png"
            width="164"
          />
        </motion.div>

        {/* Title */}
        <p className="mb-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-200">
          Private Alpha
        </p>
        <h1 className="text-3xl font-semibold text-white mb-3 text-center">
          Welcome to LegionCode
        </h1>

        {/* Subtitle */}
        <p className="text-zinc-500 text-center mb-8 leading-relaxed">
          Web/cloud coding-agent workspace for GitHub repos, BYOK providers,
          and review-first changes. Use test repos or disposable branches.
        </p>

        {/* Features */}
        <div className="grid grid-cols-2 gap-4 w-full mb-8">
          <FeatureCard
            icon={Github}
            title="GitHub Integration"
            description="Select a repo"
          />
          <FeatureCard
            icon={Terminal}
            title="Cloud Sandbox"
            description="Run agent tasks"
          />
          <FeatureCard
            icon={FileCode}
            title="Review Diffs"
            description="Inspect changed files"
          />
          <FeatureCard
            icon={KeyRound}
            title="BYOK Models"
            description="Connect providers"
          />
        </div>

        {/* Connect Button */}
        <GitHubLoginButton onClick={onLogin} size="lg" variant="primary" />

        {/* Skip Option */}
        {onSkip && (
          <motion.button
            onClick={onSkip}
            className="mt-4 text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
          >
            Continue without GitHub →
          </motion.button>
        )}

        {/* Security Note */}
        <p className="mt-6 text-xs text-zinc-600 text-center">
          LegionCode is in private alpha. Expect rapid changes and occasional
          rough edges.
          <br />
          Your GitHub token is encrypted and stored securely.
          <br />
          We only request minimal permissions needed.
        </p>
      </motion.div>
    </div>
  );
}

function FloatingIcon({
  Icon,
  className,
  delay,
}: {
  Icon: React.ElementType;
  className: string;
  delay: number;
}) {
  return (
    <motion.div
      className={`absolute text-zinc-800/30 ${className}`}
      initial={{ opacity: 0 }}
      animate={{
        opacity: [0.2, 0.4, 0.2],
        y: [0, -10, 0],
        rotate: [0, 5, 0],
      }}
      transition={{
        duration: 6,
        delay,
        repeat: Infinity,
        ease: "easeInOut",
      }}
    >
      <Icon size={32} strokeWidth={1} />
    </motion.div>
  );
}

function FeatureCard({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-3 p-3 rounded-lg bg-zinc-900/50 border border-zinc-800/50">
      <div className="p-2 rounded-md bg-zinc-800/50 text-zinc-400">
        <Icon size={16} />
      </div>
      <div>
        <h3 className="text-sm font-medium text-zinc-300">{title}</h3>
        <p className="text-xs text-zinc-500">{description}</p>
      </div>
    </div>
  );
}
