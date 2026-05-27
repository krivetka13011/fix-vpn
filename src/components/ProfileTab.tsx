import type { UserProfile } from "../types";
import { formatRuDate } from "../utils/copy";

interface Props {
  user: UserProfile;
  fallbackPhoto?: string;
}

export function ProfileTab({ user, fallbackPhoto }: Props) {
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

  const actionLabel =
    sub.status === "active"
      ? `До ${formatRuDate(sub.endsAt)}`
      : sub.status === "expired"
        ? `Закончилась ${formatRuDate(sub.endsAt)}`
        : "Нет подписки";

  return (
    <>
      <header className="page-head">
        <p className="page-eyebrow">Аккаунт</p>
        <h1 className="page-title">Профиль</h1>
      </header>

      <div className="profile-block">
        <div className="avatar-ring">
          {photo ? (
            <img src={photo} alt="" className="profile-avatar" />
          ) : (
            <div className="profile-avatar placeholder">
              {user.displayName.charAt(0).toUpperCase()}
            </div>
          )}
        </div>
        <h2 className="profile-name">{user.displayName}</h2>
        {user.username && (
          <p className="profile-handle">@{user.username}</p>
        )}
      </div>

      <div className="stat-grid">
        <div className="stat-cell">
          <span className="stat-label">Тариф</span>
          <span className="stat-value">{tariffName}</span>
        </div>
        <div className="stat-cell">
          <span className="stat-label">Статус</span>
          <span className="stat-value">
            <span className={`badge ${statusClass}`}>{statusLabel}</span>
          </span>
        </div>
        <div className="stat-cell">
          <span className="stat-label">Устройства</span>
          <span className="stat-value">{devicesLabel}</span>
        </div>
        <div className="stat-cell wide">
          <span className="stat-label">Подписка</span>
          <span className="stat-value">{actionLabel}</span>
        </div>
      </div>
    </>
  );
}
