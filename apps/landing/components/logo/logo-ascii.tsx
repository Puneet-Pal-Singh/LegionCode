'use client';

import React from 'react';
import MobileAsciiDesign from './mobile-ascii-design';
import TabAsciiLogo from './tab-ascii-logo';

interface LogoAsciiProps {
  badge?: string;
}

export default function LogoAscii({ badge }: LogoAsciiProps) {
  return (
    <div className="w-full">
      {/* Mobile-only scaled design (below 640px) */}
      <div className="sm:hidden">
        <MobileAsciiDesign badge={badge} />
      </div>

      {/* Tablet-only scaled design (640px up to 1024px) */}
      <div className="hidden sm:block lg:hidden">
        <TabAsciiLogo badge={badge} />
      </div>

      {/* Desktop layout (1024px and up) */}
      <div className="hidden lg:flex select-none mb-10 w-full overflow-hidden flex-col items-center flex-shrink-0">
        <div className="relative inline-block max-w-full">
          <pre className="text-white font-mono text-[8px] xl:text-[9.5px] tracking-normal leading-none text-center whitespace-pre mx-auto">
{`██╗     ███████╗ ██████╗ ██╗ ██████╗ ███╗   ██╗     ██████╗ ██████╗ ██████╗ ███████╗
██║     ██╔════╝██╔════╝ ██║██╔═══██╗████╗  ██║    ██╔════╝██╔═══██╗██╔══██╗██╔════╝
██║     █████╗  ██║  ███╗██║██║   ██║██╔██╗ ██║    ██║     ██║   ██║██║  ██║█████╗  
██║     ██╔══╝  ██║   ██║██║██║   ██║██║╚██╗██║    ██║     ██║   ██║██║  ██║██╔══╝  
███████╗███████╗╚██████╔╝██║╚██████╔╝██║ ╚████║    ╚██████╗╚██████╔╝██████╔╝███████╗
╚══════╝╚══════╝ ╚═════╝ ╚═╝ ╚═════╝ ╚═╝  ╚═══╝     ╚═════╝ ╚═════╝╚══════╝╚══════╝`}
          </pre>
          {badge && (
            <div className="absolute -bottom-5 right-2 text-[10px] font-mono text-zinc-400 tracking-[0.3em] uppercase font-bold bg-black px-1.5 py-0.5 border border-white/5 rounded">
              {badge}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

