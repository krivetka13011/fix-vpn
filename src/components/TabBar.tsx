import type { TabId } from "../types";

const TABS: { id: TabId; label: string; icon: string; filled?: boolean }[] = [
  { id: "help", label: "Помощь", icon: "contact_support" },
  { id: "plans", label: "Тарифы", icon: "payments" },
  { id: "profile", label: "Профиль", icon: "person", filled: true },
];

interface Props {
  active: TabId;
  onChange: (tab: TabId) => void;
}

export function TabBar({ active, onChange }: Props) {
  return (
    <div className="tab-shell">
      <nav className="tab-bar" aria-label="Навигация">
        {TABS.map((tab) => {
          const isActive = active === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              className={`tab-item ${isActive ? "active" : ""}`}
              onClick={() => onChange(tab.id)}
              aria-current={isActive ? "page" : undefined}
            >
              <span
                className={`material-symbols-outlined ${isActive && tab.filled ? "filled" : ""}`}
              >
                {tab.icon}
              </span>
              <span>{tab.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
