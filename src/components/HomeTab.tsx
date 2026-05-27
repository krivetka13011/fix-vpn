import type { UserProfile } from "../types";

interface Props {
  user: UserProfile | null;
  onGoSubscriptions: () => void;
}

export function HomeTab({ user, onGoSubscriptions }: Props) {
  const sub = user?.subscription;
  const isActive = sub?.status === "active";
  const isExpired = sub?.status === "expired";

  return (
    <>
      <header className="header">
        <img src="/logo.png" alt="FIX VPN" className="header-logo" />
        <div>
          <div className="header-title">FIX VPN</div>
          <div className="header-sub">Защищённый доступ · Hiddify · v2rayTun</div>
        </div>
      </header>

      <div className="card card-glass">
        <h2 style={{ margin: "0 0 8px", fontSize: "1.1rem" }}>
          {isActive
            ? "Подписка активна"
            : isExpired
              ? "Подписка истекла"
              : "Подключите VPN"}
        </h2>
        <p style={{ margin: "0 0 16px", color: "var(--text-muted)", fontSize: "0.9rem" }}>
          {isActive
            ? `Тариф «${sub?.planLabel}» до ${formatRuDate(sub?.endsAt)}`
            : isExpired
              ? `Срок закончился ${formatRuDate(sub?.endsAt)} — продлите доступ`
              : "Выберите тариф и получите ключ для VPN-клиента"}
        </p>
        <button type="button" className="btn-primary" onClick={onGoSubscriptions}>
          {isActive ? "Продлить подписку" : "Купить подписку"}
        </button>
        {isActive && sub?.vpnKey && (
          <button
            type="button"
            className="btn-ghost"
            style={{ width: "100%", marginTop: 10 }}
            onClick={() => copyKey(sub.vpnKey!)}
          >
            Скопировать VPN-ключ
          </button>
        )}
      </div>

      <div className="card">
        <h3 style={{ margin: "0 0 12px", fontSize: "0.95rem" }}>Как подключить</h3>
        <ul className="feature-list">
          <li>Купите подписку во вкладке «Подписки»</li>
          <li>Скопируйте ключ в профиле</li>
          <li>Вставьте в Hiddify, v2rayTun или другой клиент</li>
          <li>Включите VPN — готово</li>
        </ul>
      </div>

      <div className="card">
        <h3 style={{ margin: "0 0 8px", fontSize: "0.95rem" }}>Преимущества</h3>
        <ul className="feature-list">
          <li>Строгий минимализм и стабильная скорость</li>
          <li>Один аккаунт = ваш Telegram-профиль</li>
          <li>Тарифы на 1, 3, 6 и 12 месяцев</li>
        </ul>
      </div>
    </>
  );
}

function copyKey(key: string) {
  navigator.clipboard?.writeText(key);
  window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("light");
}

function formatRuDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
