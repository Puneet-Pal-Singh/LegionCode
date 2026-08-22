import { ShieldCheck, Database, Activity, LayoutGrid, Settings } from 'lucide-react';
import { motion } from 'framer-motion';
import { LegionCodeMark } from '../brand/LegionCodeMark';

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
        <LegionCodeMark className="h-6 w-6 text-white" />
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
