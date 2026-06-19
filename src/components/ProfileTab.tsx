import type { Catalog, UserProfile } from "../types";
import { formatRuDate } from "../utils/copy";
import { purchaseDevices, resetDevices } from "../api/client";
import { useState } from "react";

interface Props {
  user: UserProfile;
  catalog: Catalog;
  fallbackPhoto?: string;
  onRefresh: () => void | Promise<void>;
  onUserUpdate?: (user: UserProfile) => void;
  onGoToHelp?: () => void;
}

function deviceHint(
  planType: UserProfile["subscription"]["planType"],
  devicesMax: number | null,
  devicesUsed: number
): string {
  if (planType === "personal" || devicesMax == null) {
    return "Тариф Про — без лимита устройств.";
  }
  if (devicesMax <= 1) {
    return "1 устройство одновременно. Смена телефона: «Сбросить подключение» (раз в 24 ч) или докупите устройство.";
  }
  if (devicesUsed >= devicesMax) {
    return `Все ${devicesMax} устройств заняты. Докупите ещё одно или сбросьте подключение (раз в 24 ч).`;
  }
  const free = devicesMax - devicesUsed;
  return `До ${devicesMax} устройств одновременно. Свободно: ${free}.`;
}

export function ProfileTab({
  user,
  catalog,
  fallbackPhoto,
  onRefresh,
  onUserUpdate,
  onGoToHelp,
}: Props) {
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

  const tariffName = isActive
    ? sub.planLabel?.split("·")[0]?.trim() ??
      (sub.planType === "personal"
        ? "Про"
        : sub.planType === "basic"
          ? "Базовый"
          : "—")
    : sub.status === "expired"
      ? "Истекла"
      : "—";

  const periodText =
    sub.periodText ||
    (sub.startsAt && sub.endsAt
      ? `${formatRuDate(sub.startsAt)} — ${formatRuDate(sub.endsAt)}`
      : sub.endsAt
        ? `до ${formatRuDate(sub.endsAt)}`
        : null);

  const devicesUsed = sub.devicesUsed ?? 0;
  const devicesMax =
    sub.planType === "personal"
      ? null
      : (sub.devicesMax ?? sub.deviceTotal ?? 1);
  const atDeviceLimit =
    isActive &&
    devicesMax != null &&
    devicesUsed >= devicesMax;
  const connectStatusLine = sub.canConnect
    ? "Можно подключаться"
    : atDeviceLimit
      ? `Лимит ${devicesUsed}/${devicesMax} — сбросьте подключение`
      : sub.connectBlockReason?.split("\n")[0] ??
        "Синхронизация подписки…";
  const devices = sub.devices ?? [];
  const canBuyMore = Boolean(sub.canAddDevices);
  const addonPrice =
    catalog.extraDevicePricePerMonth * (sub.billingMonths ?? 1);
  const showReset =
    isActive &&
    (atDeviceLimit ||
      (Boolean(sub.hasClient) &&
        (devices.length > 0 || devicesUsed > 0 || sub.panelOnline)));

  async function handleResetDevices() {
    setResetting(true);
    setHint(null);
    try {
      const result = await resetDevices();
      setHint(
        result.message ||
          "Подключение сброшено. Подключите VPN заново во вкладке «Помощь». Следующий сброс — через 24 часа."
      );
      if (result.user) {
        onUserUpdate?.(result.user);
        if (result.user.subscription.canConnect) {
          onGoToHelp?.();
        }
      } else {
        await onRefresh();
      }
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
      setHint(result.message);
      const tg = window.Telegram?.WebApp;
      if (tg?.openLink) {
        tg.openLink(result.paymentUrl);
      } else {
        window.open(result.paymentUrl, "_blank", "noopener,noreferrer");
      }
    } catch (error) {
      setHint(error instanceof Error ? error.message : "Не удалось докупить");
    } finally {
      setBuyingDevices(false);
    }
  }

  const limitLabel =
    devicesMax == null ? "∞" : String(devicesMax);

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
            {connectStatusLine}
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
              {isActive && sub.planLabel && (
                <p className="profile-card-sub">{sub.planLabel}</p>
              )}
              {!isActive && sub.status === "expired" && sub.planLabel && (
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
                Подключено {devicesUsed}{" "}
                <span style={{ color: "var(--slate)", fontWeight: 400 }}>
                  / {limitLabel}
                </span>
              </p>
              {sub.panelOnline && (
                <p className="profile-card-sub online-hint">
                  Есть активное подключение в панели
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
                  Подключитесь во вкладке «Помощь» — устройства появятся здесь.
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
                    : catalog.testMode
                      ? `+1 устройство · ${catalog.testCheckoutPriceRub ?? 1} ₽`
                      : `+1 устройство · от ${addonPrice} ₽`}
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
