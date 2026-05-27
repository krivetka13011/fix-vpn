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
    setHint("Ключ скопирован — вставьте в клиент и включите VPN");
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("medium");
  }

  return (
    <>
      <header className="page-head">
        <p className="page-eyebrow">FIX VPN</p>
        <h1 className="page-title">Помощь</h1>
        <p className="page-desc">Поддержка, установка клиента и подключение</p>
      </header>

      <div className="stack">
        <div className="action-row">
          <button
            type="button"
            className="action-card support"
            onClick={() => openSupportChat(catalog.supportTelegramId)}
          >
            <span className="action-icon">💬</span>
            <span className="action-label">Поддержка</span>
          </button>
          <button
            type="button"
            className="action-card channel"
            onClick={() => openTelegramLink(catalog.telegramChannelUrl)}
          >
            <span className="action-icon">📢</span>
            <span className="action-label">Канал</span>
          </button>
        </div>

        <div className="surface surface-tint">
          <p className="section-label">Устройство</p>
          <div className="chip-row">
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

        <div className="surface surface-tint">
          <p className="section-label">Клиент</p>
          <div className="chip-row">
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

        <button type="button" className="btn btn-fill" onClick={handleInstall}>
          Установить клиент
        </button>
        <button type="button" className="btn btn-outline" onClick={handleConnect}>
          Подключиться
        </button>

        {hint && <p className="toast">{hint}</p>}

        {key && (
          <div className="surface">
            <p className="section-label">VPN-ключ</p>
            <div className="key-box">{key}</div>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              style={{ marginTop: 12 }}
              onClick={() => copyText(key)}
            >
              Скопировать
            </button>
          </div>
        )}
      </div>
    </>
  );
}
