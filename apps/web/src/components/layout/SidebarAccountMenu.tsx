import { LogOut, Settings, UserRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export interface SidebarAccountUser {
  login: string;
  avatar: string;
  name: string | null;
}

interface SidebarAccountMenuProps {
  user?: SidebarAccountUser | null;
  onOpenSettings: () => void;
  onLogout?: () => Promise<void>;
}

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

export function SidebarAccountMenu({
  user,
  onOpenSettings,
  onLogout,
}: SidebarAccountMenuProps): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const displayName = user?.name?.trim() || user?.login || "Account";
  const initials = getInitials(displayName) || "LC";

  useEffect(() => {
    function handleClickOutside(event: MouseEvent): void {
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }

    function handleEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, []);

  async function handleLogout(): Promise<void> {
    if (!onLogout) return;
    setIsLoggingOut(true);
    setLogoutError(null);
    try {
      await onLogout();
      setIsOpen(false);
    } catch {
      setLogoutError("Could not log out. Try again.");
    } finally {
      setIsLoggingOut(false);
    }
  }

  if (!user || !onLogout) {
    return (
      <button
        type="button"
        onClick={onOpenSettings}
        className="inline-flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-900 hover:text-zinc-100"
      >
        <Settings size={15} className="text-zinc-400" aria-hidden="true" />
        Settings
      </button>
    );
  }

  return (
    <div className="relative" ref={menuRef}>
      {isOpen ? (
        <div
          role="menu"
          aria-label="Account menu"
          className="ui-surface-popover absolute bottom-[calc(100%+0.5rem)] left-0 z-40 w-full min-w-56 p-2 shadow-2xl"
        >
          <div className="flex items-center gap-2.5 border-b border-white/[0.07] px-2 py-2.5">
            <UserRound size={16} className="text-zinc-500" aria-hidden="true" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-zinc-200">
                {displayName}
              </p>
              <p className="truncate text-[11px] text-zinc-500">
                @{user.login}
              </p>
            </div>
          </div>
          <div className="pt-1.5">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setIsOpen(false);
                onOpenSettings();
              }}
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm text-zinc-200 transition-colors hover:bg-zinc-800"
            >
              <Settings size={16} className="text-zinc-400" aria-hidden="true" />
              Settings
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => void handleLogout()}
              disabled={isLoggingOut}
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm text-zinc-200 transition-colors hover:bg-zinc-800 disabled:cursor-wait disabled:text-zinc-500"
            >
              <LogOut size={16} className="text-zinc-400" aria-hidden="true" />
              {isLoggingOut ? "Logging out…" : "Log out"}
            </button>
            {logoutError ? (
              <p
                role="alert"
                className="px-2 pb-1 pt-1 text-[11px] text-red-300"
              >
                {logoutError}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setIsOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-zinc-900"
      >
        {user.avatar ? (
          <img
            src={user.avatar}
            alt=""
            className="h-7 w-7 shrink-0 rounded-full border border-white/10 bg-zinc-800"
          />
        ) : (
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/10 bg-zinc-800 text-[10px] font-medium text-zinc-300">
            {initials}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-200">
          {displayName}
        </span>
      </button>
    </div>
  );
}
