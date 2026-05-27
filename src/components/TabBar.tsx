import type { TabId } from "../types";

const TABS: { id: TabId; label: string; icon: JSX.Element }[] = [
  {
    id: "instructions",
    label: "Инструкция",
    icon: (
      <svg className="tab-icon" viewBox="0 0 24 24">
        <path d="M12 6v12M8 10h8M6 4h12a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2z" />
      </svg>
    ),
  },
  {
    id: "plans",
    label: "Тарифы",
    icon: (
      <svg className="tab-icon" viewBox="0 0 24 24">
        <path d="M4 6h16v2H4V6zm0 5h16v2H4v-2zm0 5h10v2H4v-2z" />
        <circle cx="18" cy="17" r="3" />
      </svg>
    ),
  },
  {
    id: "support",
    label: "Поддержка",
    icon: (
      <svg className="tab-icon" viewBox="0 0 24 24">
        <path d="M12 2a7 7 0 00-7 7c0 2.5 1.2 4.7 3 6v3l3-2h1a7 7 0 000-14zm0 4a2 2 0 110 4 2 2 0 010-4z" />
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
