interface Props {
  title?: string;
}

export function AppHeader({ title }: Props) {
  return (
    <header className="app-header">
      <div className="app-header-brand">
        <img src="/logo.png" alt="" className="app-header-logo" />
        <span className="app-header-name">FIX VPN</span>
      </div>
      {title ? (
        <span className="app-header-title">{title}</span>
      ) : (
        <span className="material-symbols-outlined app-header-icon" aria-hidden>
          signal_cellular_alt
        </span>
      )}
    </header>
  );
}
