import type { UserProfile } from "../types";
import { copyText, formatRuDate } from "../utils/copy";

interface Props {
  user: UserProfile;
  onGoPlans: () => void;
}

export function InstructionsTab({ user, onGoPlans }: Props) {
  const sub = user.subscription;
  const key = sub.vpnKey;

  return (
    <>
      <header className="header">
        <img src="/logo.png" alt="FIX VPN" className="header-logo" />
        <div>
          <div className="header-title">Инструкция</div>
          <div className="header-sub">Подключение за 4 шага</div>
        </div>
      </header>

      <div className="card card-glass">
        <h2 className="section-title">Как подключить VPN</h2>
        <ol className="steps-list">
          <li>
            <strong>Купите тариф</strong> во вкладке «Тарифы» — Базовый (1 устройство)
            или Персональный сервер (безлимит устройств).
          </li>
          <li>
            <strong>Скопируйте ключ</strong> ниже или в профиле после оплаты.
          </li>
          <li>
            <strong>Откройте клиент</strong> Hiddify, v2rayTun, v2rayNG или Streisand.
          </li>
          <li>
            <strong>Импортируйте ключ</strong> (вставить из буфера / QR) и включите VPN.
          </li>
        </ol>
      </div>

      <div className="card">
        <h3 className="section-title-sm">VPN-ключ</h3>
        {key ? (
          <>
            <div className="key-box">{key}</div>
            <button
              type="button"
              className="btn-primary"
              style={{ marginTop: 12 }}
              onClick={() => copyText(key)}
            >
              Скопировать ключ
            </button>
            {sub.status === "active" && (
              <p className="hint-text">
                Тариф «{sub.planLabel}» · до {formatRuDate(sub.endsAt)}
              </p>
            )}
          </>
        ) : (
          <>
            <p className="hint-text">
              Ключ появится после оформления подписки.
            </p>
            <button type="button" className="btn-primary" onClick={onGoPlans}>
              Перейти к тарифам
            </button>
          </>
        )}
      </div>

      <div className="card">
        <h3 className="section-title-sm">Клиенты</h3>
        <ul className="feature-list">
          <li>Hiddify — Windows, macOS, Android, iOS</li>
          <li>v2rayTun / v2rayNG — мобильные устройства</li>
          <li>Streisand — iOS</li>
        </ul>
      </div>
    </>
  );
}
