import type { UserProfile } from "../types";
import { formatRuDate } from "../utils/copy";
import { resetDevices } from "../api/client";
import { useState } from "react";

interface Props {
  user: UserProfile;
  fallbackPhoto?: string;
  onRefresh: () => void;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ProfileTab({ user, fallbackPhoto, onRefresh }: Props) {
  const sub = user.subscription;
  const photo = user.photoUrl ?? fallbackPhoto;
  const isActive = sub.status === "active";
  const [resetting, setResetting] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const statusLabel = isActive
    ? sub.isTrial
      ? "Пробный период"
      : "Активна"
    : sub.status === "expired"
      ? "Истекла"
      : "Неактивна";

  const tariffName =
    sub.planLabel?.split("·")[0]?.trim() ??
    (sub.planType === "personal"
      ? "Про"
      : sub.planType === "basic"
        ? "Базовый"
        : "—");

  const periodText =
    sub.periodText ||
    (sub.startsAt && sub.endsAt
      ? `${formatRuDate(sub.startsAt)} — ${formatRuDate(sub.endsAt)}`
      : sub.endsAt
        ? `до ${formatRuDate(sub.endsAt)}`
        : null);

  const devicesUsed = sub.devicesUsed ?? 0;
  const devicesMax = sub.deviceTotal ?? sub.devicesMax ?? 1;
  const devices = sub.devices ?? [];

  async function handleResetDevices() {
    setResetting(true);
    setHint(null);
    try {
      await resetDevices();
      setHint("Привязки сброшены. Можно подключиться заново.");
      onRefresh();
    } catch (error) {
      setHint(error instanceof Error ? error.message : "Не удалось сбросить");
    } finally {
      setResetting(false);
    }
  }

  return (
    <>
      <section className="profile-hero">
        <div className="avatar-wrap">
          <div className="avatar-ring">
            {photo ? (
              <img src={photo} alt="" className="profile-avatar" />
            ) : (
              <div className="profile-avatar placeholder">
                {user.displayName.charAt(0).toUpperCase()}
              </div>
            )}
          </div>
          <span
            className={`status-pill ${isActive ? "active" : "inactive"}`}
          >
            {statusLabel.toUpperCase()}
          </span>
        </div>
        <h1 className="profile-name">{user.displayName}</h1>
        {user.username && (
          <p className="profile-status-line">@{user.username}</p>
        )}
        {isActive && (
          <div className="profile-status-line">
            <span className="status-dot" aria-hidden />
            {sub.canConnect ? "Можно подключаться" : "Синхронизация подписки…"}
          </div>
        )}
      </section>

      <div className="profile-grid">
        <div className="glass-panel metallic profile-card">
          <div className="profile-card-glow" aria-hidden />
          <div className="profile-card-top">
            <div>
              <p className="profile-card-label">Текущий тариф</p>
              <p className="profile-card-value large">{tariffName}</p>
              {sub.planLabel && (
                <p className="profile-card-sub">{sub.planLabel}</p>
              )}
            </div>
            <span className="material-symbols-outlined filled profile-card-icon">
              workspace_premium
            </span>
          </div>
        </div>

        <div className="glass-panel profile-card">
          <div className="profile-card-top">
            <div>
              <p className="profile-card-label">Период подписки</p>
              <p className="profile-card-value">
                {periodText || (isActive ? "Активна" : "Нет подписки")}
              </p>
              {sub.billingMonths != null && sub.billingMonths > 0 && (
                <p className="profile-card-sub">
                  Оплачено: {sub.billingMonths} мес.
                </p>
              )}
            </div>
            <span className="material-symbols-outlined profile-card-icon">
              event
            </span>
          </div>
        </div>

        <div className="glass-panel profile-card">
          <div className="profile-card-top">
            <div style={{ flex: 1 }}>
              <p className="profile-card-label">Устройства</p>
              <p className="profile-card-value">
                {devicesUsed}{" "}
                <span style={{ color: "var(--slate)", fontWeight: 400 }}>
                  / {sub.planType === "personal" ? "∞" : devicesMax} слотов
                </span>
              </p>
              {sub.panelOnline && (
                <p className="profile-card-sub online-hint">
                  В панели есть активное подключение (по IP)
                </p>
              )}
              {sub.planType !== "personal" && (
                <p className="profile-card-sub">
                  Одновременно 1 устройство. Чтобы подключить другое — сбросьте привязки.
                </p>
              )}
              {devices.length === 0 ? (
                <p className="profile-card-sub">
                  Подключитесь во вкладке «Помощь» — устройство появится здесь.
                </p>
              ) : (
                <ul className="device-list">
                  {devices.map((device) => (
                    <li key={device.id} className="device-row">
                      <div>
                        <span className="device-row-title">{device.label}</span>
                        <span className="device-row-sub">
                          Последний вход: {formatDateTime(device.lastSeenAt)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {(devices.length > 0 || devicesUsed > 0 || sub.panelOnline) && (
                <button
                  type="button"
                  className="btn btn-ghost btn-pill device-reset-btn"
                  disabled={resetting}
                  onClick={handleResetDevices}
                >
                  {resetting ? "Сброс…" : "Сбросить привязки"}
                </button>
              )}
            </div>
            <span className="material-symbols-outlined profile-card-icon">
              devices
            </span>
          </div>
        </div>
      </div>

      {hint && <p className="toast">{hint}</p>}
    </>
  );
}
