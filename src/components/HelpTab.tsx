import { useState } from "react";
import type { Catalog, DevicePlatform, UserProfile, VpnClientId } from "../types";
import { CLIENTS, installUrl, PLATFORMS } from "../data/helpLinks";
import { copyText, openSupportChat, openTelegramLink } from "../utils/copy";

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
    q: "Подключение не удаётся?",
    a: "Проверьте ключ в профиле, обновите подписку и попробуйте другой клиент (Happ, v2rayTun, Hiddify).",
  },
  {
    q: "Куда писать в поддержку?",
    a: "Напишите @Fixvpnmng — ответим на вопросы по оплате, ключам и настройке.",
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
  const [openFaq, setOpenFaq] = useState<number | null>(null);
  const key = user.subscription.vpnKey;

  function handleInstall() {
    if (!platform || !client) {
      setHint("Выберите устройство и клиент");
      return;
    }
    openTelegramLink(installUrl(client, platform));
    setHint(null);
  }

  function handleConnect() {
    if (!platform || !client) {
      setHint("Выберите устройство и клиент");
      return;
    }
    if (!key) {
      setHint("Сначала оформите подписку во вкладке «Тарифы»");
      return;
    }
    copyText(key);
    setHint("Ключ скопирован — вставьте в клиент и включите VPN");
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("medium");
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
        <button type="button" className="btn btn-fill" onClick={handleConnect}>
          <span className="material-symbols-outlined">bolt</span>
          Подключиться
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

        <button
          type="button"
          className="support-card"
          onClick={() => openSupportChat(catalog.supportTelegramUsername)}
        >
          <span className="client-row-left">
            <span className="support-card-icon">
              <span className="material-symbols-outlined">support_agent</span>
            </span>
            <span>
              <span className="support-card-title">Связаться с поддержкой</span>
              <span className="support-card-sub">
                Ответим на любые вопросы 24/7
              </span>
            </span>
          </span>
          <span className="material-symbols-outlined">arrow_forward_ios</span>
        </button>

        <button
          type="button"
          className="support-card"
          onClick={() => openTelegramLink(catalog.telegramChannelUrl)}
        >
          <span className="client-row-left">
            <span className="support-card-icon">
              <span className="material-symbols-outlined filled">send</span>
            </span>
            <span>
              <span className="support-card-title">Telegram-канал</span>
              <span className="support-card-sub">
                Новости, обновления и акции
              </span>
            </span>
          </span>
          <span className="material-symbols-outlined">arrow_forward_ios</span>
        </button>

        {key && (
          <div className="glass-panel" style={{ padding: 18 }}>
            <p className="section-label">VPN-ключ</p>
            <div className="key-box">{key}</div>
            <button
              type="button"
              className="btn btn-ghost btn-pill"
              style={{ marginTop: 12 }}
              onClick={() => copyText(key)}
            >
              Скопировать
            </button>
          </div>
        )}

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
