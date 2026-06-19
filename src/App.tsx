import { useCallback, useEffect, useState } from "react";
import { fetchCatalog, fetchMe } from "./api/client";
import { AppHeader } from "./components/AppHeader";
import { TabBar } from "./components/TabBar";
import { HelpTab } from "./components/HelpTab";
import { PlansTab } from "./components/PlansTab";
import { ProfileTab } from "./components/ProfileTab";
import type { Catalog, TabId, UserProfile } from "./types";
import { debugClientLog } from "./utils/debugLog";

const DEFAULT_CATALOG: Catalog = {
  tariffs: [
    {
      id: "basic",
      name: "Базовый",
      subtitle: "199 ₽ / мес",
      includedDevices: 1,
      speedMbps: null,
      features: [
        "Безлимитный трафик",
        "Выбор нескольких стран",
        "1 устройство в тарифе",
        "Доп. устройства +75 ₽ / мес",
      ],
      periods: { 1: 199, 2: 378, 3: 529, 6: 999, 12: 1799 },
    },
    {
      id: "personal",
      name: "Про",
      subtitle: "999 ₽ / мес · личный сервер",
      includedDevices: null,
      speedMbps: 1000,
      features: [
        "Личный сервер",
        "Безграничное количество устройств",
        "Скорость до 1000 Мб/с",
        "Безлимитный трафик",
      ],
      periods: { 1: 999, 2: 1898, 3: 2697, 6: 4799, 12: 8999 },
    },
  ],
  extraDevicePricePerMonth: 75,
  supportTelegramUsername: "Fixvpnmng",
  telegramChannelUrl: "https://t.me/FIXVPNfast",
  billingMonths: [1, 2, 3, 6, 12],
};

function emptySubscription(): UserProfile["subscription"] {
  return {
    status: "none",
    planType: null,
    planLabel: null,
    billingMonths: null,
    startsAt: null,
    endsAt: null,
    purchasedAt: null,
    extraDevices: 0,
    deviceTotal: null,
    canConnect: false,
    devicesUsed: 0,
    devicesMax: 1,
    devices: [],
  };
}

function devFallbackUser(): UserProfile | null {
  const tg = window.Telegram?.WebApp?.initDataUnsafe?.user;
  if (!tg) return null;
  const name = [tg.first_name, tg.last_name].filter(Boolean).join(" ");
  return {
    id: tg.id,
    displayName: name || tg.username || "Пользователь",
    username: tg.username ?? null,
    photoUrl: tg.photo_url ?? null,
    subscription: emptySubscription(),
    addons: [],
  };
}

export default function App() {
  const [tab, setTab] = useState<TabId>("help");
  const [user, setUser] = useState<UserProfile | null>(() => devFallbackUser());
  const [catalog, setCatalog] = useState<Catalog>(DEFAULT_CATALOG);
  const [syncing, setSyncing] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setSyncing(true);
    setApiError(null);

    const [catalogResult, meResult] = await Promise.allSettled([
      fetchCatalog(),
      fetchMe(),
    ]);

    if (catalogResult.status === "fulfilled") {
      setCatalog(catalogResult.value);
    }

    if (meResult.status === "fulfilled") {
      const nextUser = meResult.value.user;
      // #region agent log
      debugClientLog(
        "App.tsx:load",
        "profile loaded without reset-to-empty",
        {
          status: nextUser.subscription.status,
          canConnect: nextUser.subscription.canConnect,
          devicesUsed: nextUser.subscription.devicesUsed,
        },
        "K"
      );
      // #endregion
      setUser(nextUser);
    } else {
      setUser((prev) => {
        const fallback = prev ?? devFallbackUser();
        if (!fallback) {
          const reason = meResult.reason;
          setApiError(
            reason instanceof Error
              ? reason.message
              : "Откройте приложение через Telegram"
          );
        }
        // #region agent log
        debugClientLog(
          "App.tsx:load",
          "kept cached profile after /api/me failure",
          {
            hadCachedProfile: Boolean(prev),
            cachedStatus: prev?.subscription.status ?? null,
          },
          "K"
        );
        // #endregion
        return fallback;
      });
    }

    setSyncing(false);
  }, []);

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    tg?.ready();
    tg?.expand();
    tg?.setHeaderColor?.("#0a0a0a");
    tg?.setBackgroundColor?.("#0a0a0a");
    load();
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  const tgPhoto = window.Telegram?.WebApp?.initDataUnsafe?.user?.photo_url;

  if (!user) {
    return (
      <div className="app">
        <div className="app-watermark" aria-hidden />
        <main className="content">
          <div className="error-state">
            <img src="/logo.png" alt="" className="error-logo" />
            <p>
              {apiError ??
                "Откройте приложение в Telegram: @FIXVPNfast_bot"}
            </p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="app-watermark" aria-hidden />
      <AppHeader />
      <main className="content">
        {syncing && <div className="sync-line" aria-hidden />}
        {tab === "help" && (
          <HelpTab
            catalog={catalog}
            user={user}
            onRefresh={load}
            onGoToProfile={() => setTab("profile")}
            onGoToPlans={() => setTab("plans")}
          />
        )}
        {tab === "plans" && (
          <PlansTab
            catalog={catalog}
            user={user}
            onPurchased={load}
            onUserUpdate={setUser}
            onTrialActivated={() => setTab("help")}
            onGoToProfile={() => setTab("profile")}
          />
        )}
        {tab === "profile" && (
          <ProfileTab
            user={user}
            catalog={catalog}
            fallbackPhoto={tgPhoto}
            onRefresh={load}
            onUserUpdate={setUser}
            onGoToHelp={() => setTab("help")}
          />
        )}
      </main>
      <TabBar active={tab} onChange={setTab} />
    </div>
  );
}
