import { useState } from "react";
import type { Catalog, UserProfile } from "../types";
import { purchaseDevices } from "../api/client";
import { copyText, formatRuDate } from "../utils/copy";

interface Props {
  user: UserProfile;
  catalog: Catalog;
  fallbackPhoto?: string;
  onGoBuyDevices: () => void;
  onUserUpdated: () => void;
}

export function ProfileTab({
  user,
  catalog,
  fallbackPhoto,
  onGoBuyDevices,
  onUserUpdated,
}: Props) {
  const [expanded, setExpanded] = useState(true);
  const [deviceAdd, setDeviceAdd] = useState(1);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const sub = user.subscription;
  const photo = user.photoUrl ?? fallbackPhoto;

  const statusLabel =
    sub.status === "active"
      ? "Активна"
      : sub.status === "expired"
        ? "Истекла"
        : "Неактивна";

  const statusClass =
    sub.status === "active"
      ? "badge-active"
      : sub.status === "expired"
        ? "badge-expired"
        : "badge-none";

  const canBuyDevices =
    sub.status === "active" && sub.planType === "basic";

  async function handleBuyDevices() {
    setLoading(true);
    setMsg(null);
    try {
      const res = await purchaseDevices(deviceAdd);
      setMsg(res.message);
      onUserUpdated();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="profile-hero">
        {photo ? (
          <img src={photo} alt="" className="profile-avatar" />
        ) : (
          <div className="profile-avatar placeholder">
            {user.displayName.charAt(0).toUpperCase()}
          </div>
        )}
        <div className="profile-name">{user.displayName}</div>
        {user.username && (
          <div className="profile-username">@{user.username}</div>
        )}
      </div>

      <div className="card card-glass">
        <div className="detail-row">
          <span>ID в системе</span>
          <span className="mono-id">{user.publicId}</span>
        </div>
        <button
          type="button"
          className="btn-ghost"
          style={{ width: "100%", marginTop: 8 }}
          onClick={() => copyText(user.publicId)}
        >
          Скопировать ID
        </button>
      </div>

      <div className="card card-glass">
        <button
          type="button"
          className="subscription-row"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <span>
            Подписка
            <span className={`badge ${statusClass}`} style={{ marginLeft: 10 }}>
              {statusLabel}
            </span>
          </span>
          <svg
            className={`chevron ${expanded ? "open" : ""}`}
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>

        {expanded && (
          <div className="subscription-details">
            <div className="detail-row">
              <span>Тариф</span>
              <span>{sub.planLabel ?? "—"}</span>
            </div>
            <div className="detail-row">
              <span>Дата покупки</span>
              <span>{formatRuDate(sub.purchasedAt)}</span>
            </div>
            <div className="detail-row">
              <span>Окончание</span>
              <span>{formatRuDate(sub.endsAt)}</span>
            </div>
            <div className="detail-row">
              <span>Устройства</span>
              <span>
                {sub.planType === "personal"
                  ? "Безлимит"
                  : sub.deviceTotal != null
                    ? `${sub.deviceTotal} шт.`
                    : "—"}
              </span>
            </div>
            {sub.vpnKey && (
              <>
                <div className="detail-row">
                  <span>VPN-ключ</span>
                </div>
                <div className="key-box">{sub.vpnKey}</div>
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ width: "100%", marginTop: 10 }}
                  onClick={() => copyText(sub.vpnKey!)}
                >
                  Скопировать ключ
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {user.addons.length > 0 && (
        <div className="card">
          <h3 className="section-title-sm">Доп. услуги</h3>
          <ul className="addon-list">
            {user.addons.map((a) => (
              <li key={a.id}>
                <span>{a.label}</span>
                <span className="addon-meta">
                  {a.quantity} · {a.priceRub} ₽ · {formatRuDate(a.purchasedAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {canBuyDevices && (
        <div className="card">
          <h3 className="section-title-sm">Докупить устройства</h3>
          <p className="hint-text">
            +{catalog.extraDevicePricePerMonth} ₽ / устройство / мес
          </p>
          <div className="device-stepper">
            <button
              type="button"
              className="stepper-btn"
              disabled={deviceAdd <= 1}
              onClick={() => setDeviceAdd((n) => Math.max(1, n - 1))}
            >
              −
            </button>
            <span className="stepper-value">+{deviceAdd}</span>
            <button
              type="button"
              className="stepper-btn"
              disabled={deviceAdd >= 10}
              onClick={() => setDeviceAdd((n) => Math.min(10, n + 1))}
            >
              +
            </button>
          </div>
          <button
            type="button"
            className="btn-primary"
            style={{ marginTop: 12 }}
            disabled={loading}
            onClick={handleBuyDevices}
          >
            {loading ? "Оформление…" : "Докупить устройства"}
          </button>
          <button
            type="button"
            className="btn-ghost"
            style={{ width: "100%", marginTop: 8 }}
            onClick={onGoBuyDevices}
          >
            Все тарифы
          </button>
          {msg && <p className="message-text">{msg}</p>}
        </div>
      )}

      <div className="card">
        <div className="detail-row">
          <span>Telegram ID</span>
          <span>{user.id}</span>
        </div>
      </div>
    </>
  );
}
