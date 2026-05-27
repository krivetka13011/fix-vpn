import type { TabId } from "../types";

const TABS: { id: TabId; label: string; icon: JSX.Element }[] = [
  {
    id: "help",
    label: "Помощь",
    icon: (
      <svg className="tab-icon" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2a7 7 0 00-7 7c0 2.4 1.2 4.5 3 5.8V18l3-2h1a7 7 0 000-14zm0 4a2 2 0 110 4 2 2 0 010-4z" />
      </svg>
    ),
  },
  {
    id: "plans",
    label: "Тарифы",
    icon: (
      <svg className="tab-icon" viewBox="0 0 24 24" fill="currentColor">
        <path d="M4 6h16v2H4V6zm0 5h16v2H4v-2zm0 5h10v2H4v-2z" />
      </svg>
    ),
  },
  {
    id: "profile",
    label: "Профиль",
    icon: (
      <svg className="tab-icon" viewBox="0 0 24 24" fill="currentColor">
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
