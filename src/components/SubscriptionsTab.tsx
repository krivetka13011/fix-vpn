import { useState } from "react";
import type { Plan, UserProfile } from "../types";
import { purchasePlan } from "../api/client";

interface Props {
  plans: Plan[];
  user: UserProfile | null;
  onPurchased: () => void;
}

export function SubscriptionsTab({ plans, user, onPurchased }: Props) {
  const [selected, setSelected] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function handleBuy() {
    if (selected == null) return;
    setLoading(true);
    setMessage(null);
    try {
      const res = await purchasePlan(selected);
      setMessage(res.message);
      window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("medium");
      onPurchased();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Ошибка покупки");
    } finally {
      setLoading(false);
    }
  }

  const sorted = [...plans].sort((a, b) => a.months - b.months);

  return (
    <>
      <header className="header">
        <img src="/logo.png" alt="" className="header-logo" />
        <div>
          <div className="header-title">Тарифы</div>
          <div className="header-sub">Выберите срок подписки</div>
        </div>
      </header>

      {user?.subscription.status === "active" && (
        <div className="card" style={{ marginBottom: 16 }}>
          <span className="badge badge-active">Активна</span>
          <span style={{ marginLeft: 8, fontSize: "0.9rem", color: "var(--text-muted)" }}>
            {user.subscription.planLabel} · до{" "}
            {formatRuDate(user.subscription.endsAt)}
          </span>
        </div>
      )}

      {sorted.map((plan) => (
        <button
          key={plan.months}
          type="button"
          className={`card plan-card ${selected === plan.months ? "selected" : ""}`}
          onClick={() => setSelected(plan.months)}
        >
          {plan.badge && <span className="plan-badge">{plan.badge}</span>}
          <div style={{ fontWeight: 600, fontSize: "1.05rem" }}>{plan.label}</div>
          <div className="price" style={{ marginTop: 8 }}>
            {plan.priceRub} ₽
          </div>
          <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: 4 }}>
            Ключ для VPN-клиента · демо-цены
          </div>
        </button>
      ))}

      <button
        type="button"
        className="btn-primary"
        disabled={selected == null || loading}
        onClick={handleBuy}
        style={{ marginTop: 8 }}
      >
        {loading ? "Оформление…" : "Оформить подписку"}
      </button>

      {message && (
        <p
          style={{
            marginTop: 12,
            fontSize: "0.85rem",
            color: "var(--text-muted)",
            textAlign: "center",
          }}
        >
          {message}
        </p>
      )}

      <p
        style={{
          marginTop: 20,
          fontSize: "0.75rem",
          color: "var(--text-muted)",
          textAlign: "center",
          lineHeight: 1.5,
        }}
      >
        Оплата пока в демо-режиме. Платёжный провайдер подключится на следующем
        этапе — серверы и реальные ключи появятся позже.
      </p>
    </>
  );
}

function formatRuDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("ru-RU");
}
