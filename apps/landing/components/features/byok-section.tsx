"use client";

import React from "react";
import { Check } from "lucide-react";

export default function ByokSection() {
  return (
    <section
      id="byok"
      className="py-24 px-6 border-t border-white/5 bg-black relative select-none overflow-hidden"
    >
      {/* Subtle decorative lights */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[250px] bg-blue-500/[0.02] blur-[120px] rounded-full pointer-events-none" />
      <div className="absolute bottom-0 right-1/4 w-80 h-80 bg-zinc-800/[0.05] rounded-full blur-[100px] pointer-events-none" />

      <div className="max-w-7xl mx-auto">
        <div className="max-w-3xl mb-14">
          <h2 className="font-display text-4xl sm:text-5xl font-normal tracking-tight text-white mb-6">
            Bring your own key
          </h2>
          <p className="text-zinc-400 text-sm sm:text-base font-light leading-relaxed max-w-2xl">
            Connect supported providers with your own credentials and keep
            control of provider choice and billing.
          </p>
        </div>

        {/* Elegant sub-header divider for Top Providers */}
        <div className="mb-8 flex items-center gap-4">
          <span className="text-zinc-500 text-[10px] font-mono uppercase tracking-widest whitespace-nowrap">
            Use top providers
          </span>
          <div className="h-px bg-white/5 flex-grow" />
        </div>

        {/* SaaS/CLI Providers Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-10">
          {/* Box 1: Google Gemini */}
          <div className="p-6 rounded-xl bg-white/[0.02] border border-white/5 hover:bg-white/[0.04] hover:border-white/10 transition-all duration-300 flex items-center gap-4">
            <div className="w-10 h-10 rounded-lg bg-cyan-500/[0.04] border border-cyan-500/15 flex items-center justify-center shrink-0 relative">
              <svg
                className="w-5 h-5 text-cyan-400"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" />
              </svg>
            </div>
            <div className="min-w-0">
              <h4 className="text-white font-medium text-sm">Google Gemini</h4>
              <p className="text-zinc-500 text-[10px] font-mono mt-0.5">
                GEMINI_API_KEY
              </p>
            </div>
          </div>

          {/* Box 2: OpenAI */}
          <div className="p-6 rounded-xl bg-white/[0.02] border border-white/5 hover:bg-white/[0.04] hover:border-white/10 transition-all duration-300 flex items-center gap-4">
            <div className="w-10 h-10 rounded-lg bg-emerald-500/[0.04] border border-emerald-500/15 flex items-center justify-center shrink-0">
              <svg
                className="w-5 h-5 text-emerald-400"
                viewBox="0 0 256 260"
                fill="currentColor"
              >
                <path d="M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74a65.586 65.586 0 0 0-111.117 23.48A64.716 64.716 0 0 0 8.866 76.58c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87 8.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z" />
              </svg>
            </div>
            <div className="min-w-0">
              <h4 className="text-white font-medium text-sm">OpenAI</h4>
              <p className="text-zinc-500 text-[10px] font-mono mt-0.5">
                OPENAI_API_KEY
              </p>
            </div>
          </div>

          {/* Box 3: Anthropic Claude */}
          <div className="p-6 rounded-xl bg-white/[0.02] border border-white/5 hover:bg-white/[0.04] hover:border-white/10 transition-all duration-300 flex items-center gap-4">
            <div className="w-10 h-10 rounded-lg bg-orange-500/[0.04] border border-orange-500/15 flex items-center justify-center shrink-0">
              <svg
                className="w-4.5 h-4.5 text-orange-400"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" />
              </svg>
            </div>
            <div className="min-w-0">
              <h4 className="text-white font-medium text-sm">
                Anthropic Claude
              </h4>
              <p className="text-zinc-500 text-[10px] font-mono mt-0.5">
                ANTHROPIC_API_KEY
              </p>
            </div>
          </div>

          {/* Box 4: OpenCode */}
          <div className="p-6 rounded-xl bg-white/[0.02] border border-white/5 hover:bg-white/[0.04] hover:border-white/10 transition-all duration-300 flex items-center gap-4">
            <div className="w-10 h-10 rounded-lg bg-indigo-500/[0.04] border border-indigo-500/15 flex items-center justify-center shrink-0">
              <svg
                className="w-4.5 h-4.5 text-indigo-400"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path d="M16 6H8v12h8V6zm4 16H4V2h16v20z" />
              </svg>
            </div>
            <div className="min-w-0">
              <h4 className="text-white font-medium text-sm">
                OpenCode Zen / Go
              </h4>
              <p className="text-zinc-500 text-[10px] font-mono mt-0.5">
                PROVIDER API KEY
              </p>
            </div>
          </div>

          {/* Box 5: OpenRouter */}
          <div className="p-6 rounded-xl bg-white/[0.02] border border-white/5 hover:bg-white/[0.04] hover:border-white/10 transition-all duration-300 flex items-center gap-4">
            <div className="w-10 h-10 rounded-lg bg-violet-500/[0.04] border border-violet-500/15 flex items-center justify-center shrink-0">
              <svg
                className="w-4.5 h-4.5 text-violet-400"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path d="M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z" />
              </svg>
            </div>
            <div className="min-w-0">
              <h4 className="text-white font-medium text-sm">OpenRouter</h4>
              <p className="text-zinc-500 text-[10px] font-mono mt-0.5">
                OPENROUTER_API_KEY
              </p>
            </div>
          </div>

          {/* Box 6: Cloudflare AI Gateway */}
          <div className="p-6 rounded-xl bg-white/[0.02] border border-white/5 hover:bg-white/[0.04] hover:border-white/10 transition-all duration-300 flex items-center gap-4">
            <div className="w-10 h-10 rounded-lg bg-orange-500/[0.04] border border-orange-500/15 flex items-center justify-center shrink-0">
              <svg
                className="w-6 h-auto text-orange-500"
                viewBox="0 0 256 116"
                fill="currentColor"
              >
                <path
                  fill="currentColor"
                  fillOpacity="0.15"
                  d="m202.357 49.394-5.311-2.124C172.085 103.434 72.786 69.289 66.81 85.997c-.996 11.286 54.227 2.146 93.706 4.059 12.039.583 18.076 9.671 12.964 24.484l10.069.031c11.615-36.209 48.683-17.73 50.232-29.68-2.545-7.857-42.601 0-31.425-35.497Z"
                />
                <path
                  fill="currentColor"
                  d="M176.332 108.348c1.593-5.31 1.062-10.622-1.593-13.809-2.656-3.187-6.374-5.31-11.154-5.842L71.17 87.634c-.531 0-1.062-.53-1.593-.53-.531-.532-.531-1.063 0-1.594.531-1.062 1.062-1.594 2.124-1.594l92.946-1.062c11.154-.53 22.839-9.56 27.087-20.182l5.312-13.809c0-.532.531-1.063 0-1.594C191.203 20.182 166.772 0 138.091 0 111.535 0 88.697 16.995 80.73 40.896c-5.311-3.718-11.684-5.843-19.12-5.31-12.747 1.061-22.838 11.683-24.432 24.43-.531 3.187 0 6.374.532 9.56C16.996 70.107 0 87.103 0 108.348c0 2.124 0 3.718.531 5.842 0 1.063 1.062 1.594 1.594 1.594h170.489c1.062 0 2.125-.53 2.125-1.594l1.593-5.842Z"
                />
                <path
                  fill="currentColor"
                  className="opacity-90"
                  d="M205.544 48.863h-2.656c-.531 0-1.062.53-1.593 1.062l-3.718 12.747c-1.593 5.31-1.062 10.623 1.594 13.809 2.655 3.187 6.373 5.31 11.153 5.843l19.652 1.062c.53 0 1.062.53 1.593.53.53.532.53 1.063 0 1.594-.531 1.063-1.062 1.594-2.125 1.594l-20.182 1.062c-11.154.53-22.838 9.56-27.087 20.182l-1.063 4.78c-.531.532 0 1.594 1.063 1.594h70.108c1.062 0 1.593-.531 1.593-1.593 1.062-4.25 2.124-9.03 2.124-13.81 0-27.618-22.838-50.456-50.456-50.456"
                />
              </svg>
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h4 className="text-white font-medium text-sm">
                  Cloudflare AI
                </h4>
                <span className="text-[8px] font-mono uppercase text-zinc-500">
                  Coming soon
                </span>
              </div>
              <p className="text-zinc-500 text-[10px] font-mono mt-0.5">
                CLOUDFLARE_API_TOKEN
              </p>
            </div>
          </div>
        </div>

        {/* Feature list checkmarks at bottom */}
        <div className="flex flex-col sm:flex-row flex-wrap gap-y-3 gap-x-8 text-zinc-400 text-xs sm:text-sm font-light select-none pt-4 border-t border-white/[0.03]">
          <div className="flex items-center gap-2">
            <Check className="w-4 h-4 text-emerald-500 shrink-0 stroke-[2.2]" />
            <span>
              Your keys, your provider account, your billing. LegionCode adds no
              token markup.
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Check className="w-4 h-4 text-emerald-500 shrink-0 stroke-[2.2]" />
            <span>
              Match each run with the provider and model best suited to the
              task.
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Check className="w-4 h-4 text-emerald-500 shrink-0 stroke-[2.2]" />
            <span>
              Provider choice stays configurable as the model catalog evolves.
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
