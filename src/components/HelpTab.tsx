import { useState } from "react";
import type { Catalog, DevicePlatform, UserProfile, VpnClientId } from "../types";
import { CLIENTS, installUrl, PLATFORMS } from "../data/helpLinks";
import { copyText, openSupportChat, openTelegramLink } from "../utils/copy";

interface Props {
  catalog: Catalog;
  user: UserProfile;
}

export function HelpTab({ catalog, user }: Props) {
  const [platform, setPlatform] = useState<DevicePlatform | null>(null);
  const [client, setClient] = useState<VpnClientId | null>(null);
  const [hint, setHint] = useState<string | null>(null);
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
    setHint("Ключ скопирован. Вставьте его в выбранный клиент и включите VPN.");
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("medium");
  }

  return (
    <>
      <header className="header">
        <img src="/logo.png" alt="FIX VPN" className="header-logo" />
        <div>
          <div className="header-title">Помощь</div>
          <div className="header-sub">Поддержка и подключение</div>
        </div>
      </header>

      <div className="card">
        <button
          type="button"
          className="btn-primary"
          onClick={() => openSupportChat(catalog.supportTelegramId)}
        >
          Связаться с поддержкой
        </button>
        <button
          type="button"
          className="btn-secondary"
          style={{ marginTop: 10 }}
          onClick={() => openTelegramLink(catalog.telegramChannelUrl)}
        >
          Telegram-канал
        </button>
      </div>

      <div className="card">
        <h3 className="section-title-sm">Устройство</h3>
        <div className="chip-grid">
          {PLATFORMS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`chip ${platform === p.id ? "active" : ""}`}
              onClick={() => setPlatform(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <h3 className="section-title-sm">Клиент</h3>
        <div className="chip-grid chip-grid-3">
          {CLIENTS.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`chip ${client === c.id ? "active" : ""}`}
              onClick={() => setClient(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <button type="button" className="btn-primary" onClick={handleInstall}>
        Установить клиент
      </button>
      <button
        type="button"
        className="btn-secondary"
        style={{ marginTop: 10 }}
        onClick={handleConnect}
      >
        Подключиться
      </button>

      {hint && <p className="message-text">{hint}</p>}

      {key && (
        <div className="card">
          <h3 className="section-title-sm">VPN-ключ</h3>
          <div className="key-box">{key}</div>
          <button
            type="button"
            className="btn-secondary"
            style={{ marginTop: 10 }}
            onClick={() => copyText(key)}
          >
            Скопировать ключ
          </button>
        </div>
      )}
    </>
  );
}
