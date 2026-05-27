import { useState } from "react";
import type { UserProfile } from "../types";

interface Props {
  user: UserProfile;
  fallbackPhoto?: string;
}

export function ProfileTab({ user, fallbackPhoto }: Props) {
  const [expanded, setExpanded] = useState(false);
  const sub = user.subscription;
  const photo = user.photoUrl ?? fallbackPhoto;

  const statusLabel =
    sub.status === "active"
      ? "Активна"
      : sub.status === "expired"
        ? "Истекла"
        : "Нет подписки";

  const statusClass =
    sub.status === "active"
      ? "badge-active"
      : sub.status === "expired"
        ? "badge-expired"
        : "badge-none";

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
        <button
          type="button"
          className="subscription-row"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <span>
            Статус подписки
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
              <span>Срок</span>
              <span>
                {sub.planMonths
                  ? `${sub.planMonths} мес.`
                  : "—"}
              </span>
            </div>
            <div className="detail-row">
              <span>Начало</span>
              <span>{formatRuDate(sub.startsAt)}</span>
            </div>
            <div className="detail-row">
              <span>Окончание</span>
              <span>{formatRuDate(sub.endsAt)}</span>
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
                  onClick={() => copyKey(sub.vpnKey!)}
                >
                  Скопировать ключ
                </button>
              </>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <div className="detail-row">
          <span>Telegram ID</span>
          <span>{user.id}</span>
        </div>
        <div className="detail-row" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
          <span>Клиенты</span>
          <span style={{ textAlign: "right", maxWidth: "55%" }}>
            Hiddify, v2rayTun, v2rayNG
          </span>
        </div>
      </div>
    </>
  );
}

function formatRuDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function copyKey(key: string) {
  navigator.clipboard?.writeText(key).then(() => {
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("light");
  });
}
