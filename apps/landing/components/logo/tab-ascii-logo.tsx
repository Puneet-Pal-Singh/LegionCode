'use client';

import React from 'react';

interface TabAsciiLogoProps {
  badge?: string;
}

export default function TabAsciiLogo({ badge }: TabAsciiLogoProps) {
  return (
    <div className="select-none mb-10 w-full overflow-hidden flex flex-col items-center flex-shrink-0">
      <div className="relative inline-block w-full max-w-[640px] px-4 mx-auto">
        {/* Same high-fidelity ASCII brand art scaled to fit tablet screen sizes perfectly */}
        <pre 
          className="text-white font-mono tracking-tight leading-none text-center whitespace-pre mx-auto"
          style={{ 
            fontSize: '7.0px',
            letterSpacing: '-0.01em',
            wordBreak: 'keep-all',
            overflowWrap: 'anywhere'
          }}
        >
{`██╗     ███████╗ ██████╗ ██╗ ██████╗ ███╗   ██╗     ██████╗ ██████╗ ██████╗ ███████╗
██║     ██╔════╝██╔════╝ ██║██╔═══██╗████╗  ██║    ██╔════╝██╔═══██╗██╔══██╗██╔════╝
██║     █████╗  ██║  ███╗██║██║   ██║██╔██╗ ██║    ██║     ██║   ██║██║  ██║█████╗  
██║     ██╔══╝  ██║   ██║██║██║   ██║██║╚██╗██║    ██║     ██║   ██║██║  ██║██╔══╝  
███████╗███████╗╚██████╔╝██║╚██████╔╝██║ ╚████║    ╚██████╗╚██████╔╝██████╔╝███████╗
╚══════╝╚══════╝ ╚═════╝ ╚═╝ ╚═════╝ ╚═╝  ╚═══╝     ╚═════╝ ╚═════╝╚══════╝╚══════╝`}
        </pre>
        {badge && (
          <div className="absolute -bottom-5 right-6 text-[9.5px] font-mono text-zinc-400 tracking-[0.28em] uppercase font-bold bg-black px-1.5 py-0.5 border border-white/5 rounded">
            {badge}
          </div>
        )}
      </div>
    </div>
  );
}
