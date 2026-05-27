import type { TabId } from "../types";

const TABS: { id: TabId; label: string; icon: JSX.Element }[] = [
  {
    id: "home",
    label: "Главная",
    icon: (
      <svg className="tab-icon" viewBox="0 0 24 24">
        <path d="M3 10.5L12 3l9 7.5V20a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1v-9.5z" />
      </svg>
    ),
  },
  {
    id: "subscriptions",
    label: "Подписки",
    icon: (
      <svg className="tab-icon" viewBox="0 0 24 24">
        <path d="M4 6h16v2H4V6zm0 5h16v2H4v-2zm0 5h10v2H4v-2z" />
        <circle cx="18" cy="17" r="3" />
      </svg>
    ),
  },
  {
    id: "profile",
    label: "Профиль",
    icon: (
      <svg className="tab-icon" viewBox="0 0 24 24">
        <circle cx="12" cy="8" r="4" />
        <path d="M4 20c0-4 3.6-6 8-6s8 2 8 6" />
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
  );
}
