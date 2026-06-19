import { useState } from "react";
import type { Catalog, DevicePlatform, UserProfile, VpnClientId } from "../types";
import { fetchConnect, activateTrial } from "../api/client";
import { CLIENTS, installUrl, PLATFORMS } from "../data/helpLinks";
import { openSupportChat, openTelegramLink } from "../utils/copy";
import { debugClientLog } from "../utils/debugLog";

interface Props {
  catalog: Catalog;
  user: UserProfile;
  onRefresh?: () => void | Promise<void>;
  onGoToProfile?: () => void;
  onUserUpdate?: (user: UserProfile) => void;
}

const FAQ = [
  {
    q: "Как установить клиент?",
    a: "Выберите устройство и VPN-клиент, нажмите «Установить клиент» — откроется страница загрузки.",
  },
  {
    q: "Почему не подключается второе устройство?",
    a: "На базовом тарифе одновременно работает 1 устройство + докупленные. Если лимит исчерпан: «Профиль» → «Сбросить подключение» (раз в 24 ч) или докупите +1 устройство.",
  },
  {
    q: "Подключение не удаётся?",
    a: "Удалите старую подписку в клиенте и нажмите «Подключиться» снова. Ссылка останется той же.",
  },
  {
    q: "Куда писать в поддержку?",
    a: "Напишите @Fixvpnmng — ответим на вопросы по оплате и настройке.",
  },
];

const PLATFORM_ICONS: Record<DevicePlatform, string> = {
  ios: "phone_iphone",
  android: "android",
  windows: "desktop_windows",
  mac: "laptop_mac",
};

const CLIENT_ICONS: Record<VpnClientId, string> = {
  happ: "vpn_key",
  v2raytun: "security",
  hiddify: "shield",
};

export function HelpTab({ catalog, user, onRefresh, onGoToProfile, onUserUpdate }: Props) {
  const [platform, setPlatform] = useState<DevicePlatform | null>("android");
  const [client, setClient] = useState<VpnClientId | null>("happ");
  const [hint, setHint] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [trialLoading, setTrialLoading] = useState(false);
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  const isActive = user.subscription.status === "active";
  const devicesUsed = user.subscription.devicesUsed ?? 0;
  const devicesMax = user.subscription.devicesMax;
  const atDeviceLimit =
    isActive &&
    devicesMax != null &&
    devicesUsed >= devicesMax;
  const canRetrial =
    user.trialAvailable === true && user.subscription.status === "expired";
  const connectBlockReason = user.subscription.connectBlockReason;
  const canConnect = user.subscription.canConnect === true;

  function handleInstall() {
    if (!platform || !client) {
      setHint("Выберите устройство и клиент");
      return;
    }
    openTelegramLink(installUrl(client, platform));
    setHint(null);
  }

  async function handleRetrial() {
    setTrialLoading(true);
    setHint(null);
    try {
      const res = await activateTrial();
      window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("medium");
      if (res.user) {
        onUserUpdate?.(res.user);
        setHint(res.message);
        // #region agent log
        debugClientLog(
          "HelpTab.tsx:handleRetrial",
          "trial activated from help",
          {
            canConnect: res.user.subscription.canConnect,
            status: res.user.subscription.status,
          },
          "P"
        );
        // #endregion
        if (res.user.subscription.canConnect) {
          await runConnect("android", "happ");
        }
      } else {
        await onRefresh?.();
        setHint(res.message);
      }
    } catch (error) {
      setHint(error instanceof Error ? error.message : "Не удалось активировать пробный период");
    } finally {
      setTrialLoading(false);
    }
  }

  async function openConnectImport(
    platform: DevicePlatform,
    client: VpnClientId,
    result: Awaited<ReturnType<typeof fetchConnect>>
  ): Promise<void> {
    const tg = window.Telegram?.WebApp;
    const openUrl = result.redirectUrl || result.connectUrl;
    if (client === "happ" && platform === "android") {
      const subUrl =
        result.subUrl || result.connectUrl.replace(/^happ:\/\/add\//i, "");
      const redirectHttps = result.redirectUrl?.startsWith("https://")
        ? result.redirectUrl
        : openUrl.startsWith("https://")
          ? openUrl
          : null;
      if (tg?.openLink && redirectHttps) {
        tg.openLink(redirectHttps);
        setHint("Открываем Happ для импорта подписки…");
        // #region agent log
        debugClientLog(
          "HelpTab.tsx:openConnectImport",
          "happ android tg.openLink redirect",
          { redirectUrl: redirectHttps.slice(0, 80) },
          "S"
        );
        // #endregion
        return;
      }
      if (result.connectUrl.startsWith("happ://")) {
        window.location.assign(result.connectUrl);
        setHint("Открываем Happ…");
        // #region agent log
        debugClientLog(
          "HelpTab.tsx:openConnectImport",
          "happ android deeplink assign fallback",
          { connectUrl: result.connectUrl.slice(0, 80) },
          "S"
        );
        // #endregion
        return;
      }
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(subUrl);
        } else {
          window.prompt("Скопируйте ссылку подписки:", subUrl);
        }
        setHint("Ссылка скопирована. В Happ: Добавить → вставьте ссылку.");
      } catch {
        setHint(`Скопируйте: ${subUrl}`);
      }
      return;
    }
    if (tg?.openLink) {
      tg.openLink(openUrl);
      setHint("Открываем импорт подписки в клиент…");
    } else {
      window.location.href = result.connectUrl;
      setHint("Открываем импорт подписки в клиент…");
    }
  }

  async function runConnect(platform: DevicePlatform, client: VpnClientId) {
    setConnecting(true);
    setHint(null);
    try {
      const result = await fetchConnect(platform, client);
      await openConnectImport(platform, client, result);
      window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("medium");
      await onRefresh?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Не удалось подключиться";
      // #region agent log
      debugClientLog(
        "HelpTab.tsx:runConnect",
        "connect failed",
        { message, platform, client },
        "L"
      );
      // #endregion
      setHint(message);
    } finally {
      setConnecting(false);
    }
  }

  async function handleConnect() {
    if (!platform || !client) {
      setHint("Выберите устройство и клиент");
      return;
    }
    if (!canConnect) {
      setHint(
        connectBlockReason ??
          (atDeviceLimit
            ? `Подключено ${devicesUsed}/${devicesMax}. Сбросьте подключение в профиле или докупите устройство.`
            : isActive
              ? "Подписка синхронизируется. Подождите минуту и повторите."
              : "Сначала активируйте пробный период во вкладке «Тарифы» или оформите подписку.")
      );
      return;
    }

    await runConnect(platform, client);
  }

  return (
    <>
      <section className="page-hero">
        <img src="/logo.png" alt="" className="page-hero-logo" />
        <h1 className="page-title">Помощь</h1>
        <p className="page-desc">
          Установка клиента, подключение и поддержка FIX VPN
        </p>
      </section>

      <div className="stack">
        {!canConnect && isActive && atDeviceLimit && (
          <>
            <p className="toast">
              {connectBlockReason ??
                `Подключено ${devicesUsed}/${devicesMax}. Сбросьте подключение в профиле или докупите устройство.`}
            </p>
            {onGoToProfile && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={onGoToProfile}
              >
                <span className="material-symbols-outlined">devices</span>
                Перейти в профиль → сбросить подключение
              </button>
            )}
          </>
        )}
        {!canConnect && isActive && !atDeviceLimit && connectBlockReason && (
          <p className="toast">
            {connectBlockReason ??
              "Подписка активна — идёт подготовка ссылки для подключения."}
          </p>
        )}
        {!isActive && user.subscription.status === "expired" && canRetrial && (
          <>
            <p className="toast">
              Пробный период завершён. Нажмите кнопку ниже — активируем пробный период и
              откроем Happ.
            </p>
            <button
              type="button"
              className="btn btn-fill btn-pill"
              disabled={trialLoading || connecting}
              onClick={handleRetrial}
            >
              <span className="material-symbols-outlined">bolt</span>
              {trialLoading || connecting
                ? trialLoading
                  ? "Активация…"
                  : "Подключение…"
                : catalog.trialDurationMinutes
                  ? `Активировать · ${catalog.trialDurationMinutes} мин`
                  : "Активировать пробный период"}
            </button>
          </>
        )}
        {!isActive && user.subscription.status === "expired" && !canRetrial && (
          <p className="toast">
            {user.subscription.isTrial
              ? "Пробный период завершён. Оформите подписку во вкладке «Тарифы»."
              : "Подписка истекла. Продлите её во вкладке «Тарифы»."}
          </p>
        )}
        {!isActive && user.subscription.status !== "expired" && (
          <p className="toast">
            Для подключения активируйте пробный период во вкладке «Тарифы» или оформите подписку.
          </p>
        )}

        <div>
          <p className="section-label">Выберите устройство</p>
          <div className="chip-scroll">
            {PLATFORMS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`chip-pill ${platform === p.id ? "active" : ""}`}
                onClick={() => setPlatform(p.id)}
              >
                <span className="material-symbols-outlined">
                  {PLATFORM_ICONS[p.id]}
                </span>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="section-label">Выберите клиент</p>
          <div className="stack" style={{ gap: 8 }}>
            {CLIENTS.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`client-row ${client === c.id ? "active" : ""}`}
                onClick={() => setClient(c.id)}
              >
                <span className="client-row-left">
                  <span className="client-icon">
                    <span className="material-symbols-outlined">
                      {CLIENT_ICONS[c.id]}
                    </span>
                  </span>
                  <span className="client-name">{c.label}</span>
                </span>
                {client === c.id && (
                  <span className="material-symbols-outlined filled">
                    check_circle
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        <button type="button" className="btn btn-ghost" onClick={handleInstall}>
          <span className="material-symbols-outlined">download</span>
          Установить клиент
        </button>
        <button
          type="button"
          className="btn btn-fill"
          disabled={connecting || !canConnect}
          onClick={handleConnect}
        >
          <span className="material-symbols-outlined">bolt</span>
          {connecting
            ? "Подключение…"
            : canConnect
              ? "Подключиться"
              : "Подключение недоступно"}
        </button>

        {hint && <p className="toast">{hint}</p>}

        <div className="divider" />

        <div className="bento-grid">
          <button
            type="button"
            className="glass-panel bento-item"
            onClick={() => openSupportChat(catalog.supportTelegramUsername)}
          >
            <span className="bento-icon">
              <span className="material-symbols-outlined filled">chat</span>
            </span>
            <span>
              <span className="bento-label">Поддержка</span>
              <span className="bento-sub">@{catalog.supportTelegramUsername}</span>
            </span>
          </button>
          <button
            type="button"
            className="glass-panel bento-item"
            onClick={() => openTelegramLink(catalog.telegramChannelUrl)}
          >
            <span className="bento-icon">
              <span className="material-symbols-outlined filled">forum</span>
            </span>
            <span>
              <span className="bento-label">Канал</span>
              <span className="bento-sub">Telegram</span>
            </span>
          </button>
        </div>

        <div>
          <p className="section-label accent">Частые вопросы</p>
          <div className="stack" style={{ gap: 10 }}>
            {FAQ.map((item, i) => (
              <div key={item.q} className="faq-item">
                <button
                  type="button"
                  className="faq-trigger"
                  onClick={() => setOpenFaq(openFaq === i ? null : i)}
                  aria-expanded={openFaq === i}
                >
                  <span>{item.q}</span>
                  <span
                    className={`material-symbols-outlined ${openFaq === i ? "open" : ""}`}
                  >
                    add
                  </span>
                </button>
                {openFaq === i && <div className="faq-body">{item.a}</div>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
