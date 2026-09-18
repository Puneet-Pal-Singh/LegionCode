export function ClientShellLoading({ label }: { label: string }) {
  return (
    <div className="lc-client-screen">
      <div role="status" aria-label={label} className="lc-client-status">
        <span className="lc-client-spinner" aria-hidden="true" />
        <span>{label}</span>
      </div>
    </div>
  );
}
