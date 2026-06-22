'use client';

import React from 'react';

export default function CloudBackground() {
  return (
    <div className="absolute inset-0 z-0 pointer-events-none select-none font-mono text-[9px] leading-tight text-zinc-800/25 overflow-hidden">
      {/* Layer 1: Left scatter */}
      <div className="absolute -top-12 left-[5%] w-[45%] opacity-40 whitespace-pre leading-[1.3] text-zinc-800/15 hidden md:block">
                  .+*++.
               +=========-
            -::-=========+---=-
           -+**++-.-===-==+++++++
         .---...:++==========+++*+++
       .==.      .:--=====-====+++*-
      -==          .:---========+++-
     -+-             :---=======+++-
    -*-               :---======++=.
    +-                 :---=====++-
    +                  .---=====++-
    =                  .---=====++:
    .                  .---=====++-
                       .---=====++-
                       .---=====++:
                       .---=====++-
                       .---=====+=.
                      .---=====+*
                    .---=====+**
                  .:---=====+**-
                .::--=====+***-
              .::--=====+****-
            .::--=====+****=.
         ..::--=====+****+-
       ..::--=====+****+-
  ....::--=====+*****+-
      </div>

      {/* Layer 2: Right side dense text block pattern */}
      <div className="absolute top-[10%] right-[3%] w-[40%] text-right font-mono text-[8px] leading-[1.3] opacity-20 whitespace-pre hidden md:block">
==========================:  ===-
-===========================: -===*-
  -===========================:.==++-
   :===========================.-++-
     =========================-.++=.
      -=======================:-++.
       :=====================:-++-
        .===================: -++:
          -=================. -++-
            -==============-  -++-
              :-==========-   -++:
                .:--====-     -++-
                   .---..     -++-
                              -++:
                              -++-
                              -++-
                             -++-
                            .++-
                           .++-
                          .++-
                         .++-
                       .++-    __
                     .++-     |  |
                   .++-       |  |
                 .++-         |__|
               .++-
             .++-
      </div>

      {/* Layer 3: Dynamic lines of code and container info scattered */}
      <div className="absolute top-[45%] left-[8%] opacity-15 whitespace-pre hidden lg:block">
{`system_orchestrator // init...
[LEGION_CLOUD] booting cluster-01_aistudio
[g1-small] container instances active: 16
[PORT] http://localhost:3000 -> https://conductor.build/cloud
------------------------------------------------------
module.exports = {
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
        mono: ["var(--font-mono)"],
      }
    }
  }
}`}
      </div>

      <div className="absolute bottom-[10%] right-[12%] opacity-15 whitespace-pre text-left hidden lg:block">
{`// parallel execution engine for isolated tasks
export async function runJob(task: AgentTask) {
  const container = await docker.createContainer({
    Image: 'legioncode-runner-v2',
    Cmd: ['npm', 'run', 'agent', task.id],
    Env: [\`TASK_PAYLOAD=\${task.payload}\`]
  });
  await container.start();
  return container;
}`}
      </div>

      {/* Layer 4: Big central shadow masking to highlight the center lockup */}
      <div className="absolute inset-x-0 top-0 h-full bg-radial-[ellipse_at_center,_var(--tw-gradient-stops)] from-transparent via-black/45 to-black -z-10" />
    </div>
  );
}
