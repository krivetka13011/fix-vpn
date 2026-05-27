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
        : "Нет активной подписки";

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
      </div>

      <div className="card profile-card">
        <div className="profile-stat">
          <span className="profile-stat-label">Тариф</span>
          <span className="profile-stat-value">{tariffName}</span>
        </div>
        <div className="profile-stat">
          <span className="profile-stat-label">Подписка</span>
          <span className="profile-stat-value">
            <span className={`badge ${statusClass}`}>{statusLabel}</span>
          </span>
        </div>
        <div className="profile-stat">
          <span className="profile-stat-label">Действие</span>
          <span className="profile-stat-value">{actionLabel}</span>
        </div>
        <div className="profile-stat">
          <span className="profile-stat-label">Устройства</span>
          <span className="profile-stat-value">{devicesLabel}</span>
        </div>
      </div>
    </>
  );
}
