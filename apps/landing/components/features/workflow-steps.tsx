'use client';

import React from 'react';

const STEPS = [
  {
    number: '01',
    title: 'Connect your repo',
    description: 'Connect a GitHub repository and choose the branch to work from.',
  },
  {
    number: '02',
    title: 'Start a thread',
    description: 'Describe the task with the context your agent needs.',
  },
  {
    number: '03',
    title: 'Spin up an isolated sandbox',
    description: 'Every task gets its own cloud sandbox and Git worktree, isolated from your original repository.',
  },
  {
    number: '04',
    title: 'Let the agent work',
    description: 'The agent reads code, makes changes, and runs tools and commands in that environment.',
  },
  {
    number: '05',
    title: 'Review and ship',
    description: 'Review the diff, leave feedback, iterate, and open a pull request when ready.',
  },
];

export default function WorkflowSteps() {
  return (
    <section id="workflow" className="relative overflow-hidden border-t border-white/5 bg-black px-6 py-24 select-none lg:py-32">
      {/* Background radial highlight */}
      <div className="absolute top-0 right-1/4 w-96 h-96 bg-white/[0.02] rounded-full blur-[140px] pointer-events-none" />

      <div className="max-w-7xl mx-auto">
        {/* Top Header Block */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-12 items-start mb-10 lg:mb-12">
          <div className="lg:col-span-8">
            <h2 className="font-display text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-medium tracking-tight text-white leading-[1.1] max-w-2xl">
              An isolated, end-to-end agent workflow for your codebase.
            </h2>
          </div>
          <div className="lg:col-span-4 lg:pt-1.5">
            <p className="text-zinc-400 text-[18px] leading-[1.55] font-light max-w-[360px]">
              Threads keep the task, context, and feedback together from the first prompt to final review.
            </p>
          </div>
        </div>

        {/* 5 Steps Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-8 lg:gap-6">
          {STEPS.map((step) => (
            <div key={step.number} className="flex flex-col justify-start">
              <div className="font-display text-4xl sm:text-5xl font-bold text-white mb-4 tracking-tight">
                {step.number}
              </div>
              <h3 className="font-display font-semibold text-white text-base sm:text-lg mb-2.5 tracking-tight">
                {step.title}
              </h3>
              <p className="text-[13px] font-light leading-[1.65] text-zinc-400 sm:text-sm sm:leading-relaxed">
                {step.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
