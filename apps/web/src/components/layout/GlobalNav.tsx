import { ShieldCheck, Database, Activity, LayoutGrid, Settings } from 'lucide-react';
import { motion } from 'framer-motion';

interface GlobalNavProps {
  onHome?: () => void;
}

export function GlobalNav({ onHome }: GlobalNavProps) {
  return (
    <aside className="w-16 border-r border-border flex flex-col items-center py-4 gap-4 bg-[#0c0c0e] overflow-hidden">
      {/* Logo */}
      <motion.button
        onClick={onHome}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        className="w-10 h-10 bg-zinc-800/80 border border-zinc-700/50 rounded-xl flex items-center justify-center text-white shadow-lg shadow-emerald-500/5 cursor-pointer hover:bg-zinc-700 hover:border-zinc-600 transition-all"
      >
        <LegionCodeMark />
      </motion.button>

      {/* Navigation */}
      <nav className="flex flex-col gap-2">
        <NavIcon 
          icon={<LayoutGrid size={18} />} 
          label="Dashboard" 
          onClick={onHome}
          active
        />
        <NavIcon 
          icon={<ShieldCheck size={18} />} 
          label="Security" 
        />
        <NavIcon 
          icon={<Database size={18} />} 
          label="Storage" 
        />
        <NavIcon 
          icon={<Activity size={18} />} 
          label="Monitoring" 
        />
      </nav>

      {/* Divider */}
      <div className="flex-1" />

      {/* Settings */}
      <NavIcon 
        icon={<Settings size={18} />} 
        label="Settings" 
      />
    </aside>
  );
}

function LegionCodeMark() {
  return (
    <svg
      aria-hidden="true"
      className="h-6 w-6 text-white"
      viewBox="2800 2850 6900 6900"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform="translate(0 12540) scale(1 -1)" fill="currentColor">
        <path d="M7662 8873 c-121 -362 -293 -872 -382 -1133 -89 -261 -181 -533 -205 -605 -24 -71 -96 -283 -160 -470 -64 -187 -231 -677 -370 -1090 -139 -412 -293 -869 -342 -1015 l-90 -264 -244 -170 c-255 -176 -676 -466 -864 -594 -60 -42 -143 -98 -182 -125 -40 -28 -75 -48 -78 -45 -3 2 38 133 91 289 53 156 147 435 209 619 62 184 173 508 245 720 73 212 223 655 335 985 112 330 310 913 440 1295 130 382 294 864 364 1070 l128 374 429 273 c236 151 492 314 569 362 77 49 180 114 230 145 49 31 91 53 93 47 2 -5 -96 -306 -216 -668z M5450 8125 c0 -2 -50 -161 -111 -352 -61 -192 -119 -375 -130 -408 -14 -44 -26 -64 -46 -76 -16 -9 -170 -109 -343 -222 -173 -113 -435 -283 -582 -377 -148 -95 -268 -175 -268 -180 0 -5 26 -44 58 -87 149 -200 615 -859 619 -873 4 -15 -236 -765 -242 -758 -9 11 -693 972 -848 1193 -105 149 -248 353 -320 454 -106 150 -127 185 -115 195 7 7 114 77 238 156 124 79 405 261 625 403 220 143 594 384 830 536 237 152 473 304 525 338 91 59 110 69 110 58z M8330 7905 c51 -71 109 -152 130 -180 236 -318 910 -1260 1072 -1496 41 -60 41 -63 22 -77 -10 -8 -264 -174 -564 -369 -300 -195 -725 -473 -945 -618 -675 -443 -867 -567 -870 -563 -2 3 54 184 189 613 37 116 73 216 80 223 7 8 125 87 262 177 827 543 1003 661 1000 671 -4 11 -95 136 -566 782 -93 129 -170 239 -170 245 0 11 217 683 236 730 9 24 10 23 124 -138z" />
      </g>
    </svg>
  );
}

interface NavIconProps {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
}

function NavIcon({ icon, label, onClick, active = false }: NavIconProps) {
  return (
    <motion.button
      onClick={onClick}
      whileHover={{ scale: 1.1 }}
      whileTap={{ scale: 0.95 }}
      className={`p-2.5 rounded-lg transition-all border ${
        active
          ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
          : 'text-zinc-500 hover:text-zinc-200 border-transparent hover:bg-zinc-800/50'
      }`}
      title={label}
    >
      {icon}
    </motion.button>
  );
}
