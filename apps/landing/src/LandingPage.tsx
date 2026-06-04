import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  Code2,
  FileDiff,
  FolderGit2,
  Github,
  GitPullRequest,
  KeyRound,
  LockKeyhole,
  ShieldCheck,
  TerminalSquare,
  type LucideIcon,
} from "lucide-react";

const GITHUB_URL = "https://github.com/Puneet-Pal-Singh/LegionCode";

const workflowSteps: Array<{
  title: string;
  description: string;
  icon: LucideIcon;
}> = [
  {
    title: "Run the task",
    description: "Start from a natural-language prompt in a cloud sandbox.",
    icon: TerminalSquare,
  },
  {
    title: "Review the diff",
    description: "Edited files stay visible in chat and review panels.",
    icon: FileDiff,
  },
  {
    title: "Approve risky steps",
    description: "Git and shell mutations pass through explicit approvals.",
    icon: ShieldCheck,
  },
  {
    title: "Keep history",
    description: "Runs, messages, and review state are built to reload.",
    icon: Clock3,
  },
];

const providerChips = ["OpenAI", "OpenRouter", "Groq", "Anthropic"];

const reviewBullets = [
  "Changed files in chat",
  "Multi-file review sidebar",
  "Saved edit artifacts when git diff is empty",
  "Final success or failure message",
  "Approval state for risky actions",
];

const alphaColumns = [
  {
    title: "Works now",
    items: [
      "Web agent workspace",
      "Cloud sandbox runs",
      "GitHub repo setup",
      "BYOK provider setup",
      "Changed-file review",
    ],
  },
  {
    title: "Being rebuilt",
    items: [
      "Runtime kernel",
      "Event log",
      "Workspace manifest",
      "Git ownership model",
      "Provider SDK path",
    ],
  },
  {
    title: "Not ready yet",
    items: [
      "Desktop app",
      "CLI",
      "Local execution",
      "External harness adapters",
      "Self-hosted workers",
    ],
  },
];

export function LandingPage() {
  return (
    <main className="h-screen overflow-x-hidden overflow-y-auto bg-[#050505] text-zinc-100">
      <LandingHeader />
      <HeroSection />
      <WorkflowSection />
      <ProviderSection />
      <ReviewSection />
      <AlphaSection />
      <TrustSection />
      <FinalCtaSection />
    </main>
  );
}

export function CloudReservedPage() {
  return (
    <main className="flex h-screen items-center justify-center bg-[#050505] px-6 text-zinc-100">
      <section className="w-full max-w-2xl rounded-lg border border-zinc-800 bg-zinc-950 p-8">
        <BrandLockup />
        <p className="mt-8 text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">
          Reserved
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-normal text-white">
          Cloud agents get their own page later.
        </h1>
        <p className="mt-4 max-w-xl text-sm leading-6 text-zinc-400">
          LegionCode private alpha is web/cloud sandbox first today. The future
          cloud agents page is intentionally reserved while the runtime rebuild
          continues.
        </p>
        <a
          className="mt-7 inline-flex items-center gap-2 rounded-md bg-white px-4 py-2 text-sm font-semibold text-black transition-colors hover:bg-zinc-200"
          href="/agents"
        >
          Open Agents
          <ArrowRight size={16} />
        </a>
      </section>
    </main>
  );
}

function LandingHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-zinc-900 bg-[#050505]/92 backdrop-blur">
      <div className="mx-auto flex w-full max-w-[22rem] items-center justify-between gap-3 px-5 py-4 sm:max-w-7xl sm:px-6 lg:px-8">
        <BrandLockup />
        <nav className="hidden items-center gap-6 text-sm text-zinc-400 md:flex">
          <a className="transition-colors hover:text-white" href="#workflow">
            Workflow
          </a>
          <a className="transition-colors hover:text-white" href="#providers">
            Providers
          </a>
          <a className="transition-colors hover:text-white" href="#review">
            Review
          </a>
        </nav>
        <a
          className="hidden shrink-0 items-center gap-2 rounded-md border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-100 transition-colors hover:border-zinc-500 hover:bg-zinc-900 sm:inline-flex"
          href="/agents"
        >
          Open Agents
          <ArrowRight size={15} />
        </a>
      </div>
    </header>
  );
}

function BrandLockup() {
  return (
    <a className="flex items-center gap-3" href="/" aria-label="LegionCode">
      <img
        alt="LegionCode"
        className="h-7 w-auto max-w-[9rem] sm:h-8 sm:max-w-none"
        height="32"
        src="/assets/legioncode-wordmark.png"
        width="131"
      />
    </a>
  );
}

function HeroSection() {
  return (
    <section className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)] gap-10 overflow-hidden px-5 pb-12 pt-12 sm:px-6 lg:grid-cols-[minmax(0,0.88fr)_minmax(0,1.12fr)] lg:px-8 lg:pb-14 lg:pt-16">
      <div className="flex w-full max-w-[22rem] min-w-0 flex-col justify-center sm:max-w-none">
        <p className="w-fit max-w-full rounded-full border border-amber-500/35 bg-amber-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-200">
          Private alpha · use test repos or disposable branches
        </p>
        <h1 className="mt-7">
          <span className="block text-5xl font-semibold tracking-normal text-white sm:hidden">
            LegionCode
          </span>
          <img
            alt="LegionCode"
            className="hidden h-auto w-full max-w-full sm:block sm:max-w-[34rem]"
            height="176"
            src="/assets/legioncode-wordmark.png"
            width="720"
          />
        </h1>
        <p className="mt-4 text-2xl font-medium tracking-normal text-zinc-200 sm:text-3xl">
          The OSS AI coding agents.
        </p>
        <p className="mt-6 max-w-2xl text-base leading-7 text-zinc-400 sm:text-lg">
          Run agent tasks in an isolated web/cloud sandbox, inspect every
          changed file, and connect models from supported external providers.
          Private alpha is web-first while local, desktop, and runtime rebuild
          work continues.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <a
            className="inline-flex items-center justify-center gap-2 rounded-md bg-white px-5 py-3 text-sm font-semibold text-black transition-colors hover:bg-zinc-200"
            href="/agents"
          >
            Open Agents
            <ArrowRight size={17} />
          </a>
          <a
            className="inline-flex items-center justify-center gap-2 rounded-md border border-zinc-700 px-5 py-3 text-sm font-semibold text-zinc-100 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
            href={GITHUB_URL}
            rel="noreferrer"
            target="_blank"
          >
            <Github size={17} />
            View GitHub
          </a>
        </div>
      </div>
      <ProductVisual />
    </section>
  );
}

function ProductVisual() {
  return (
    <div className="w-full max-w-[22rem] min-w-0 overflow-hidden rounded-lg border border-zinc-800 bg-[#09090b] p-3 shadow-[0_24px_90px_rgba(0,0,0,0.42)] sm:max-w-none">
      <div className="grid min-h-[31rem] grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-[minmax(0,0.88fr)_minmax(0,1.12fr)]">
        <PromptPanel />
        <ReviewPanel />
      </div>
    </div>
  );
}

function PromptPanel() {
  return (
    <section className="min-w-0 rounded-md border border-zinc-800 bg-black p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-900 pb-3">
        <div className="flex items-center gap-2">
          <FolderGit2 size={15} className="text-cyan-300" />
          <span className="text-xs font-medium text-zinc-300">
            demo/review-branch
          </span>
        </div>
        <span className="rounded-full border border-emerald-500/30 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-300">
          Sandbox running
        </span>
      </div>
      <div className="mt-5 rounded-md border border-zinc-800 bg-zinc-950 p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">
          Prompt
        </p>
        <p className="mt-3 text-sm leading-6 text-zinc-200">
          Add a provider setup guard, update copy, and make the final response
          clear when a risky git step needs approval.
        </p>
      </div>
      <div className="mt-4 space-y-3">
        <StatusRow
          icon={TerminalSquare}
          label="Read repository context"
          state="complete"
        />
        <StatusRow icon={Code2} label="Patch setup guard" state="complete" />
        <StatusRow
          icon={LockKeyhole}
          label="Waiting on git approval"
          state="approval"
        />
      </div>
    </section>
  );
}

function StatusRow({
  icon: Icon,
  label,
  state,
}: {
  icon: LucideIcon;
  label: string;
  state: "complete" | "approval";
}) {
  const stateClassName =
    state === "complete" ? "text-emerald-300" : "text-amber-300";
  const stateLabel = state === "complete" ? "Complete" : "Approval";

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2 text-sm text-zinc-300">
        <Icon size={15} className="text-zinc-500" />
        <span className="min-w-0">{label}</span>
      </div>
      <span className={`text-xs font-medium ${stateClassName}`}>
        {stateLabel}
      </span>
    </div>
  );
}

function ReviewPanel() {
  return (
    <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 rounded-md border border-zinc-800 bg-[#0d0d10] p-4 md:grid-cols-[minmax(0,0.52fr)_minmax(0,1fr)]">
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">
          Changed files
        </p>
        <div className="mt-3 space-y-2">
          <ChangedFile path="apps/landing/src/App.tsx" status="+42" />
          <ChangedFile path="apps/landing/src/LandingPage.tsx" status="+280" />
          <ChangedFile path="apps/landing/public/_redirects" status="+4" />
        </div>
        <div className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
          <p className="text-xs font-semibold text-amber-200">
            Approval required
          </p>
          <p className="mt-1 text-xs leading-5 text-amber-100/80">
            Git mutation paused until the reviewer approves the exact action.
          </p>
        </div>
      </div>
      <div className="min-w-0 rounded-md border border-zinc-800 bg-black">
        <div className="flex items-center justify-between border-b border-zinc-900 px-3 py-2">
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <FileDiff size={14} className="text-emerald-300" />
            Review diff
          </div>
          <span className="text-[11px] text-zinc-500">
            saved artifact ready
          </span>
        </div>
        <pre className="overflow-x-auto p-3 text-[11px] leading-5 text-zinc-300">
          <code>{`+ <p>Private alpha, intentionally.</p>
+ <ReviewSidebar files={changedFiles} />
+ <ApprovalDock state="waiting" />
- <p>Public alpha for everyone.</p>`}</code>
        </pre>
      </div>
    </section>
  );
}

function ChangedFile({ path, status }: { path: string; status: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-zinc-800 bg-black px-3 py-2">
      <span className="min-w-0 truncate text-xs text-zinc-300">{path}</span>
      <span className="text-xs font-medium text-emerald-300">{status}</span>
    </div>
  );
}

function WorkflowSection() {
  return (
    <section
      className="border-y border-zinc-900 bg-zinc-950/70 px-5 py-14 sm:px-6 lg:px-8"
      id="workflow"
    >
      <SectionHeading
        eyebrow="Workflow"
        title="Prompt -> edit -> review -> ship"
        description="LegionCode turns an agent run into a reviewable workspace change, not just a chat transcript."
      />
      <div className="mx-auto mt-8 grid max-w-7xl gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {workflowSteps.map((step) => (
          <WorkflowCard key={step.title} {...step} />
        ))}
      </div>
    </section>
  );
}

function WorkflowCard({
  title,
  description,
  icon: Icon,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
}) {
  return (
    <article className="rounded-lg border border-zinc-800 bg-black p-5">
      <Icon size={20} className="text-cyan-300" />
      <h3 className="mt-5 text-base font-semibold text-white">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-zinc-400">{description}</p>
    </article>
  );
}

function ProviderSection() {
  return (
    <section
      className="mx-auto max-w-7xl px-5 py-16 sm:px-6 lg:px-8"
      id="providers"
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[minmax(0,0.75fr)_minmax(0,1fr)] lg:items-start">
        <SectionHeading
          align="left"
          eyebrow="BYOK"
          title="Connect models from top providers."
          description="Use supported external providers and keep control of your model lane. LegionCode is being built around provider choice, not token lock-in."
        />
        <div className="grid gap-3 sm:grid-cols-2">
          {providerChips.map((provider) => (
            <div
              className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950 p-4"
              key={provider}
            >
              <span className="text-sm font-medium text-zinc-100">
                {provider}
              </span>
              <span className="rounded-full border border-emerald-500/30 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-300">
                BYOK
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ReviewSection() {
  return (
    <section
      className="border-y border-zinc-900 bg-[#08080a] px-5 py-16 sm:px-6 lg:px-8"
      id="review"
    >
      <div className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1fr)] lg:items-center">
        <SectionHeading
          align="left"
          eyebrow="Review first"
          title="Agent output is not done until you can review it."
          description="Changed files appear in chat and in the review sidebar. If live git misses a change, saved edit artifacts keep the review path alive."
        />
        <div className="grid gap-3 sm:grid-cols-2">
          {reviewBullets.map((item) => (
            <div
              className="flex items-start gap-3 rounded-lg border border-zinc-800 bg-black p-4"
              key={item}
            >
              <CheckCircle2
                className="mt-0.5 shrink-0 text-emerald-300"
                size={17}
              />
              <span className="text-sm leading-6 text-zinc-300">{item}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function AlphaSection() {
  return (
    <section className="mx-auto max-w-7xl px-5 py-16 sm:px-6 lg:px-8">
      <SectionHeading
        eyebrow="Private alpha"
        title="Private alpha, intentionally."
        description="LegionCode is stable enough to test and review, but still early. Use test repos or disposable branches while the runtime is rebuilt toward one kernel, one event log, one workspace manifest, one git owner, and one SDK."
      />
      <div className="mt-8 grid gap-3 md:grid-cols-3">
        {alphaColumns.map((column) => (
          <article
            className="rounded-lg border border-zinc-800 bg-zinc-950 p-5"
            key={column.title}
          >
            <h3 className="text-base font-semibold text-white">
              {column.title}
            </h3>
            <ul className="mt-4 space-y-3">
              {column.items.map((item) => (
                <li className="flex gap-2 text-sm text-zinc-400" key={item}>
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-500" />
                  {item}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}

function TrustSection() {
  return (
    <section className="border-y border-zinc-900 bg-zinc-950/70 px-5 py-14 sm:px-6 lg:px-8">
      <div className="mx-auto grid max-w-7xl gap-6 md:grid-cols-3">
        <TrustItem
          icon={Code2}
          title="TypeScript monorepo"
          description="Brain, web, runtime contracts, and shared types move together."
        />
        <TrustItem
          icon={GitPullRequest}
          title="Builder feedback welcome"
          description="The alpha is for careful testing, review, and practical fixes."
        />
        <TrustItem
          icon={KeyRound}
          title="Provider freedom direction"
          description="BYOK is the product path; hidden provider fallback is not the story."
        />
      </div>
    </section>
  );
}

function TrustItem({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <article className="rounded-lg border border-zinc-800 bg-black p-5">
      <Icon className="text-emerald-300" size={20} />
      <h3 className="mt-4 text-base font-semibold text-white">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-zinc-400">{description}</p>
    </article>
  );
}

function FinalCtaSection() {
  return (
    <section className="mx-auto max-w-4xl px-5 py-16 text-center sm:px-6 lg:px-8">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">
        Try the private alpha
      </p>
      <h2 className="mt-4 text-3xl font-semibold tracking-normal text-white sm:text-4xl">
        Bring a safe repo, review every file, and run the agent.
      </h2>
      <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
        <a
          className="inline-flex items-center justify-center gap-2 rounded-md bg-white px-5 py-3 text-sm font-semibold text-black transition-colors hover:bg-zinc-200"
          href="/agents"
        >
          Open Agents
          <ArrowRight size={17} />
        </a>
        <a
          className="inline-flex items-center justify-center gap-2 rounded-md border border-zinc-700 px-5 py-3 text-sm font-semibold text-zinc-100 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
          href={GITHUB_URL}
          rel="noreferrer"
          target="_blank"
        >
          View GitHub
        </a>
      </div>
    </section>
  );
}

function SectionHeading({
  eyebrow,
  title,
  description,
  align = "center",
}: {
  eyebrow: string;
  title: string;
  description: string;
  align?: "center" | "left";
}) {
  const alignmentClassName = align === "center" ? "mx-auto text-center" : "";

  return (
    <div className={`max-w-3xl ${alignmentClassName}`}>
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">
        {eyebrow}
      </p>
      <h2 className="mt-3 text-3xl font-semibold tracking-normal text-white sm:text-4xl">
        {title}
      </h2>
      <p className="mt-4 text-base leading-7 text-zinc-400">{description}</p>
    </div>
  );
}
