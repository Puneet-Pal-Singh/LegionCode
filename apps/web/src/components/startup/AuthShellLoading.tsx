export function AuthShellLoading() {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background text-zinc-300">
      <div
        role="status"
        aria-label="Checking session"
        className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950/80 px-4 py-3 shadow-[0_18px_60px_rgba(0,0,0,0.35)]"
      >
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-200" />
        <span className="text-sm font-medium">Checking session</span>
      </div>
    </div>
  );
}
