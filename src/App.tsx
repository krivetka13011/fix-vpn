import { useCallback, useEffect, useState } from "react";
import { fetchCatalog, fetchMe } from "./api/client";
import { TabBar } from "./components/TabBar";
import { InstructionsTab } from "./components/InstructionsTab";
import { PlansTab } from "./components/PlansTab";
import { SupportTab } from "./components/SupportTab";
import { ProfileTab } from "./components/ProfileTab";
import type { Catalog, TabId, UserProfile } from "./types";

const DEFAULT_CATALOG: Catalog = {
  tariffs: [
    {
      id: "basic",
      name: "Базовый",
      subtitle: "1 устройство в тарифе",
      includedDevices: 1,
      periods: { 1: 199, 3: 499, 6: 899, 12: 1499 },
    },
    {
      id: "personal",
      name: "Персональный сервер",
      subtitle: "Высокая скорость · безлимит устройств",
      includedDevices: null,
      periods: { 1: 499, 3: 1299, 6: 2299, 12: 3999 },
    },
  ],
  extraDevicePricePerMonth: 99,
  supportTelegramId: 8312175683,
  billingMonths: [1, 3, 6, 12],
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
    vpnKey: null,
    extraDevices: 0,
    deviceTotal: null,
  };
}

function devFallbackUser(): UserProfile | null {
  const tg = window.Telegram?.WebApp?.initDataUnsafe?.user;
  if (!tg) return null;
  const name = [tg.first_name, tg.last_name].filter(Boolean).join(" ");
  return {
    id: tg.id,
    publicId: "local-preview",
    displayName: name || tg.username || "Пользователь",
    username: tg.username ?? null,
    photoUrl: tg.photo_url ?? null,
    subscription: emptySubscription(),
    addons: [],
  };
}

export default function App() {
  const [tab, setTab] = useState<TabId>("instructions");
  const [plansFocusDevices, setPlansFocusDevices] = useState(false);
  const [user, setUser] = useState<UserProfile | null>(() => devFallbackUser());
  const [catalog, setCatalog] = useState<Catalog>(DEFAULT_CATALOG);
  const [syncing, setSyncing] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setSyncing(true);
    setApiError(null);
    const fallback = devFallbackUser();
    if (fallback) setUser(fallback);

    const [catalogResult, meResult] = await Promise.allSettled([
      fetchCatalog(),
      fetchMe(),
    ]);

    if (catalogResult.status === "fulfilled") {
      setCatalog(catalogResult.value);
    }

    if (meResult.status === "fulfilled") {
      setUser(meResult.value.user);
    } else if (!fallback) {
      const reason = meResult.reason;
      setApiError(
        reason instanceof Error
          ? reason.message
          : "Откройте приложение через Telegram"
      );
    }

    setSyncing(false);
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

  if (!user) {
    return (
      <div className="app">
        <main className="content">
          <div className="error-state">
            <img
              src="/logo.png"
              alt=""
              style={{ width: 72, marginBottom: 16, borderRadius: 12 }}
            />
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
      <main className="content">
        {syncing && (
          <div className="loading" style={{ marginBottom: 8, opacity: 0.7 }}>
            Синхронизация…
          </div>
        )}
        {tab === "instructions" && (
          <InstructionsTab
            user={user}
            onGoPlans={() => setTab("plans")}
          />
        )}
        {tab === "plans" && (
          <PlansTab
            catalog={catalog}
            user={user}
            onPurchased={load}
            focusExtraDevices={plansFocusDevices}
          />
        )}
        {tab === "support" && <SupportTab catalog={catalog} />}
        {tab === "profile" && (
          <ProfileTab
            user={user}
            catalog={catalog}
            fallbackPhoto={tgPhoto}
            onGoBuyDevices={() => {
              setPlansFocusDevices(true);
              setTab("plans");
            }}
            onUserUpdated={load}
          />
        )}
      </main>
      <TabBar
        active={tab}
        onChange={(t) => {
          if (t !== "plans") setPlansFocusDevices(false);
          setTab(t);
        }}
      />
    </div>
  );
}
