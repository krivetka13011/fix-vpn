import { useCallback, useEffect, useState } from "react";
import { fetchMe, fetchPlans } from "./api/client";
import { TabBar } from "./components/TabBar";
import { HomeTab } from "./components/HomeTab";
import { SubscriptionsTab } from "./components/SubscriptionsTab";
import { ProfileTab } from "./components/ProfileTab";
import type { Plan, TabId, UserProfile } from "./types";

const DEFAULT_PLANS: Plan[] = [
  { months: 1, label: "1 месяц", priceRub: 199 },
  { months: 3, label: "3 месяца", priceRub: 499, badge: "−15%" },
  { months: 6, label: "6 месяцев", priceRub: 899, badge: "−25%" },
  { months: 12, label: "1 год", priceRub: 1499, badge: "Лучшая цена" },
];

function devFallbackUser(): UserProfile | null {
  const tg = window.Telegram?.WebApp?.initDataUnsafe?.user;
  if (!tg) return null;
  const name = [tg.first_name, tg.last_name].filter(Boolean).join(" ");
  return {
    id: tg.id,
    displayName: name || tg.username || "Пользователь",
    username: tg.username ?? null,
    photoUrl: tg.photo_url ?? null,
    subscription: {
      status: "none",
      planMonths: null,
      planLabel: null,
      startsAt: null,
      endsAt: null,
      vpnKey: null,
    },
  };
}

export default function App() {
  const [tab, setTab] = useState<TabId>("home");
  const [user, setUser] = useState<UserProfile | null>(() => devFallbackUser());
  const [plans, setPlans] = useState<Plan[]>(DEFAULT_PLANS);
  const [loading, setLoading] = useState(true);
  const [apiError, setApiError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setApiError(null);
    const fallback = devFallbackUser();
    if (fallback) setUser(fallback);

    try {
      const plansRes = await fetchPlans();
      setPlans(plansRes.plans);
    } catch {
      setPlans(DEFAULT_PLANS);
    }

    try {
      const meRes = await fetchMe();
      setUser(meRes.user);
    } catch (e) {
      if (!fallback) {
        setApiError(
          e instanceof Error
            ? e.message
            : "Откройте приложение через Telegram"
        );
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    tg?.ready();
    tg?.expand();
    tg?.setHeaderColor?.("#121212");
    tg?.setBackgroundColor?.("#121212");
    document.documentElement.style.setProperty(
      "--bg",
      tg?.themeParams?.bg_color ?? "#121212"
    );
    load();
  }, [load]);

  const tgPhoto = window.Telegram?.WebApp?.initDataUnsafe?.user?.photo_url;

  if (apiError && !user) {
    return (
      <div className="app">
        <main className="content">
          <div className="error-state">
            <img
              src="/logo.png"
              alt=""
              style={{ width: 72, marginBottom: 16, borderRadius: 12 }}
            />
            <p>{apiError}</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <main className="content">
        {loading && (
          <div className="loading" style={{ marginBottom: 8 }}>
            Синхронизация…
          </div>
        )}
        {user && (
          <>
            {tab === "home" && (
              <HomeTab
                user={user}
                onGoSubscriptions={() => setTab("subscriptions")}
              />
            )}
            {tab === "subscriptions" && (
              <SubscriptionsTab
                plans={plans}
                user={user}
                onPurchased={load}
              />
            )}
            {tab === "profile" && (
              <ProfileTab user={user} fallbackPhoto={tgPhoto} />
            )}
          </>
        )}
      </main>
      <TabBar active={tab} onChange={setTab} />
    </div>
  );
}
