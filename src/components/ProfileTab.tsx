import type { UserProfile } from "../types";
import { formatRuDate } from "../utils/copy";

interface Props {
  user: UserProfile;
  fallbackPhoto?: string;
}

export function ProfileTab({ user, fallbackPhoto }: Props) {
  const sub = user.subscription;
  const photo = user.photoUrl ?? fallbackPhoto;
  const isActive = sub.status === "active";

  const statusLabel = isActive
    ? "Активна"
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

  const devicesLabel =
    sub.planType === "personal"
      ? "Безлимит"
      : sub.deviceTotal != null
        ? `${sub.deviceTotal} шт.`
        : "1 шт.";

  const devicesUsed =
    sub.planType === "personal"
      ? 1
      : Math.min(sub.deviceTotal ?? 1, 5);

  const devicesMax = sub.planType === "personal" ? 5 : Math.max(sub.deviceTotal ?? 1, 1);

  const expiryLabel = isActive
    ? `До ${formatRuDate(sub.endsAt)}`
    : sub.status === "expired"
      ? `Закончилась ${formatRuDate(sub.endsAt)}`
      : "Нет подписки";

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
            Сеть защищена
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
            </div>
            <span className="material-symbols-outlined filled profile-card-icon">
              workspace_premium
            </span>
          </div>
        </div>

        <div className="glass-panel profile-card">
          <div className="profile-card-top">
            <div>
              <p className="profile-card-label">Срок действия</p>
              <p className="profile-card-value">{expiryLabel}</p>
              {sub.startsAt && (
                <p className="profile-card-sub">
                  с {formatRuDate(sub.startsAt)}
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
              <div className="profile-card-row">
                <p className="profile-card-value">
                  {devicesUsed}{" "}
                  <span style={{ color: "var(--slate)", fontWeight: 400 }}>
                    / {devicesMax} активны
                  </span>
                </p>
              </div>
              <p className="profile-card-sub">{devicesLabel}</p>
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{
                    width: `${Math.min(100, (devicesUsed / devicesMax) * 100)}%`,
                  }}
                />
              </div>
            </div>
            <span className="material-symbols-outlined profile-card-icon">
              devices
            </span>
          </div>
        </div>

        {sub.vpnKey && (
          <div className="glass-panel profile-card">
            <p className="profile-card-label">VPN-ключ</p>
            <div className="key-box">{sub.vpnKey}</div>
          </div>
        )}

        <div className="glass-panel profile-card">
          <div className="profile-card-row">
            <div>
              <p className="profile-card-label">Telegram ID</p>
              <p className="profile-card-value">{user.id}</p>
            </div>
            <div style={{ textAlign: "right" }}>
              <p className="profile-card-label">Публичный ID</p>
              <p className="profile-card-value">{user.publicId}</p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
