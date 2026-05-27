import { useCallback, useEffect, useState } from "react";
import { fetchMe, fetchPlans } from "./api/client";
import { TabBar } from "./components/TabBar";
import { HomeTab } from "./components/HomeTab";
import { SubscriptionsTab } from "./components/SubscriptionsTab";
import { ProfileTab } from "./components/ProfileTab";
import type { Plan, TabId, UserProfile } from "./types";

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
  const [user, setUser] = useState<UserProfile | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const plansRes = await fetchPlans();
      setPlans(plansRes.plans);
      try {
        const meRes = await fetchMe();
        setUser(meRes.user);
      } catch {
        const fallback = devFallbackUser();
        if (fallback) setUser(fallback);
        else throw new Error("Откройте приложение через Telegram");
      }
    } catch (e) {
      const fallback = devFallbackUser();
      if (fallback) {
        setUser(fallback);
        setPlans([
          { months: 1, label: "1 месяц", priceRub: 199 },
          { months: 3, label: "3 месяца", priceRub: 499, badge: "−15%" },
          { months: 6, label: "6 месяцев", priceRub: 899, badge: "−25%" },
          { months: 12, label: "1 год", priceRub: 1499, badge: "Лучшая цена" },
        ]);
        setError(null);
      } else {
        setError(
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
    tg?.enableClosingConfirmation?.();
    document.documentElement.style.setProperty(
      "--bg",
      tg?.themeParams?.bg_color ?? "#121212"
    );
    load();
  }, [load]);

  const tgPhoto = window.Telegram?.WebApp?.initDataUnsafe?.user?.photo_url;

  return (
    <div className="app">
      <main className="content">
        {loading && <div className="loading">Загрузка…</div>}
        {error && !loading && (
          <div className="error-state">
            <img
              src="/logo.png"
              alt=""
              style={{ width: 72, marginBottom: 16, borderRadius: 12 }}
            />
            <p>{error}</p>
            <p style={{ fontSize: "0.85rem" }}>
              Запустите бота и нажмите «Открыть FIX VPN»
            </p>
          </div>
        )}
        {!loading && !error && user && (
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
      {!error && <TabBar active={tab} onChange={setTab} />}
    </div>
  );
}
