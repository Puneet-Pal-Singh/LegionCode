'use client';

import React from 'react';

interface MobileAsciiDesignProps {
  badge?: string;
}

export default function MobileAsciiDesign({ badge }: MobileAsciiDesignProps) {
  return (
    <div className="select-none mb-10 w-full overflow-hidden flex flex-col items-center flex-shrink-0">
      <div className="relative inline-block w-full max-w-[340px] px-2 mx-auto">
        {/* Exact same ASCII design styled to fit compact screens */}
        <pre 
          className="text-white font-mono tracking-tighter leading-[1.0] text-center whitespace-pre mx-auto"
          style={{ 
            fontSize: '4.2px',
            letterSpacing: '-0.02em',
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
          <div className="absolute -bottom-5 right-4 text-[9px] font-mono text-zinc-400 tracking-[0.25em] uppercase font-bold bg-black px-1.5 py-0.5 border border-white/5 rounded">
            {badge}
          </div>
        )}
      </div>
    </div>
  );
}
