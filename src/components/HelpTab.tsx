import { useState } from "react";
import type { Catalog, DevicePlatform, UserProfile, VpnClientId } from "../types";
import { fetchConnect } from "../api/client";
import { CLIENTS, installUrl, PLATFORMS } from "../data/helpLinks";
import { openSupportChat, openTelegramLink } from "../utils/copy";

interface Props {
  catalog: Catalog;
  user: UserProfile;
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

export function HelpTab({ catalog, user }: Props) {
  const [platform, setPlatform] = useState<DevicePlatform | null>(null);
  const [client, setClient] = useState<VpnClientId | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  const canConnect = user.subscription.canConnect ?? user.subscription.status === "active";

  function handleInstall() {
    if (!platform || !client) {
      setHint("Выберите устройство и клиент");
      return;
    }
    openTelegramLink(installUrl(client, platform));
    setHint(null);
  }

  async function handleConnect() {
    if (!platform || !client) {
      setHint("Выберите устройство и клиент");
      return;
    }
    if (!canConnect) {
      setHint(
        user.subscription.status === "active"
          ? "Подписка синхронизируется. Подождите минуту и повторите."
          : "Сначала активируйте пробный период в боте или оформите подписку."
      );
      return;
    }

    setConnecting(true);
    setHint(null);
    try {
      const result = await fetchConnect(platform, client);
      const tg = window.Telegram?.WebApp;
      if (client === "happ" && platform === "android") {
        const subUrl = result.subUrl || result.connectUrl.replace(/^happ:\/\/add\//i, "");
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
      } else if (tg?.openLink) {
        tg.openLink(result.connectUrl);
        setHint("Открываем импорт подписки в клиент…");
      } else {
        window.location.href = result.connectUrl;
        setHint("Открываем импорт подписки в клиент…");
      }
      tg?.HapticFeedback?.impactOccurred("medium");
    } catch (error) {
      setHint(error instanceof Error ? error.message : "Не удалось подключиться");
    } finally {
      setConnecting(false);
    }
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
        {!canConnect && user.subscription.status === "active" && (
          <p className="toast">Подписка активна — идёт подготовка ссылки для подключения.</p>
        )}
        {user.subscription.status !== "active" && (
          <p className="toast">
            Для подключения активируйте пробный период в боте или оформите подписку.
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
          disabled={connecting}
          onClick={handleConnect}
        >
          <span className="material-symbols-outlined">bolt</span>
          {connecting ? "Подключение…" : "Подключиться"}
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
