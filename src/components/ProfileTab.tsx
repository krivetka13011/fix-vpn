import type { Catalog, UserProfile } from "../types";
import { formatRuDate } from "../utils/copy";
import { purchaseDevices, resetDevices } from "../api/client";
import { useState } from "react";

interface Props {
  user: UserProfile;
  catalog: Catalog;
  fallbackPhoto?: string;
  onRefresh: () => void;
}

const MAX_EXTRA_DEVICES = 10;

function deviceHint(
  planType: UserProfile["subscription"]["planType"],
  devicesMax: number,
  devicesUsed: number
): string {
  if (planType === "personal") {
    return "Тариф Про — без лимита устройств.";
  }
  if (devicesMax <= 1) {
    return "1 устройство одновременно. Смена телефона: «Сбросить подключение» (раз в 24 ч) или докупите слоты.";
  }
  if (devicesUsed >= devicesMax) {
    return `Все ${devicesMax} слотов заняты. Докупите слоты или сбросьте подключение (раз в 24 ч).`;
  }
  return `До ${devicesMax} устройств одновременно. Свободно слотов: ${devicesMax - devicesUsed}.`;
}

export function ProfileTab({ user, catalog, fallbackPhoto, onRefresh }: Props) {
  const sub = user.subscription;
  const photo = user.photoUrl ?? fallbackPhoto;
  const isActive = sub.status === "active";
  const [resetting, setResetting] = useState(false);
  const [buyingDevices, setBuyingDevices] = useState(false);
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
  const canBuyMore =
    isActive &&
    sub.planType === "basic" &&
    (sub.extraDevices ?? 0) < MAX_EXTRA_DEVICES;
  const addonPrice =
    catalog.extraDevicePricePerMonth * (sub.billingMonths ?? 1);
  const showReset =
    isActive && (devices.length > 0 || devicesUsed > 0 || sub.panelOnline);

  async function handleResetDevices() {
    setResetting(true);
    setHint(null);
    try {
      const result = await resetDevices();
      setHint(
        result.message ||
          "Подключение сброшено. Подключите VPN заново во вкладке «Помощь». Следующий сброс — через 24 часа."
      );
      onRefresh();
    } catch (error) {
      setHint(error instanceof Error ? error.message : "Не удалось сбросить");
    } finally {
      setResetting(false);
    }
  }

  async function handleBuyDevice() {
    setBuyingDevices(true);
    setHint(null);
    try {
      const result = await purchaseDevices(1);
      setHint(result.message || "Дополнительный слот добавлен.");
      onRefresh();
    } catch (error) {
      setHint(error instanceof Error ? error.message : "Не удалось докупить");
    } finally {
      setBuyingDevices(false);
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
              <p className="profile-card-sub">
                {deviceHint(sub.planType, devicesMax, devicesUsed)}
              </p>
              {devices.length > 0 ? (
                <ul className="device-list">
                  {devices.map((device) => (
                    <li key={device.id} className="device-row">
                      <div>
                        <span className="device-row-title">{device.label}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="profile-card-sub">
                  Подключитесь во вкладке «Помощь» — активные IP появятся здесь.
                </p>
              )}
              {canBuyMore && (
                <button
                  type="button"
                  className="btn btn-fill btn-pill"
                  style={{ marginTop: 10, width: "100%" }}
                  disabled={buyingDevices}
                  onClick={handleBuyDevice}
                >
                  {buyingDevices
                    ? "Оформление…"
                    : `+1 устройство · ${addonPrice} ₽`}
                </button>
              )}
              {showReset && (
                <button
                  type="button"
                  className="btn btn-ghost btn-pill device-reset-btn"
                  disabled={resetting}
                  onClick={handleResetDevices}
                >
                  {resetting ? "Сброс…" : "Сбросить подключение"}
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
