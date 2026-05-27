import type { TabId } from "../types";

const TABS: { id: TabId; label: string; icon: JSX.Element }[] = [
  {
    id: "help",
    label: "Помощь",
    icon: (
      <svg className="tab-icon" viewBox="0 0 24 24" aria-hidden>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 17v.01M12 14a2.5 2.5 0 1 0-2.5-4" />
      </svg>
    ),
  },
  {
    id: "plans",
    label: "Тарифы",
    icon: (
      <svg className="tab-icon" viewBox="0 0 24 24" aria-hidden>
        <rect x="4" y="6" width="16" height="12" rx="2" />
        <path d="M8 10h8M8 14h5" />
      </svg>
    ),
  },
  {
    id: "profile",
    label: "Профиль",
    icon: (
      <svg className="tab-icon" viewBox="0 0 24 24" aria-hidden>
        <circle cx="12" cy="9" r="3.5" />
        <path d="M5 20c0-3.5 3.1-5.5 7-5.5s7 2 7 5.5" />
      </svg>
    ),
  },
];

interface Props {
  active: TabId;
  onChange: (tab: TabId) => void;
}

export function TabBar({ active, onChange }: Props) {
  return (
    <div className="tab-shell">
      <nav className="tab-bar" aria-label="Навигация">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`tab-item ${active === tab.id ? "active" : ""}`}
            onClick={() => onChange(tab.id)}
            aria-current={active === tab.id ? "page" : undefined}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
