import { useCallback, useMemo, useState } from "react";
import type { BillingMonths, Catalog, PlanType, UserProfile } from "../types";
import { purchasePlan } from "../api/client";
import { useTelegramMainButton } from "../hooks/useTelegramMainButton";

interface Props {
  catalog: Catalog;
  user: UserProfile;
  onPurchased: () => void;
  focusExtraDevices?: boolean;
}

export function PlansTab({ catalog, user, onPurchased, focusExtraDevices }: Props) {
  const [planType, setPlanType] = useState<PlanType | null>(null);
  const [months, setMonths] = useState<BillingMonths | null>(null);
  const [extraDevices, setExtraDevices] = useState(
    focusExtraDevices ? Math.max(1, user.subscription.extraDevices) : 0
  );
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const total = useMemo(() => {
    if (!planType || !months) return null;
    const tariff = catalog.tariffs.find((t) => t.id === planType);
    if (!tariff) return null;
    const base = tariff.periods[months];
    if (planType === "personal") return base;
    return base + extraDevices * catalog.extraDevicePricePerMonth * months;
  }, [planType, months, extraDevices, catalog]);

  const handleBuy = useCallback(async () => {
    if (!planType || !months) return;
    setLoading(true);
    setMessage(null);
    try {
      const res = await purchasePlan({
        planType,
        billingMonths: months,
        extraDevices: planType === "basic" ? extraDevices : 0,
      });
      setMessage(res.message);
      window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("medium");
      onPurchased();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Ошибка покупки");
    } finally {
      setLoading(false);
    }
  }, [planType, months, extraDevices, onPurchased]);

  useTelegramMainButton(
    "Оформить подписку",
    planType != null && months != null,
    handleBuy,
    loading
  );

  return (
    <>
      <header className="header">
        <img src="/logo.png" alt="" className="header-logo" />
        <div>
          <div className="header-title">Тарифы</div>
          <div className="header-sub">Выберите план и срок</div>
        </div>
      </header>

      {user.subscription.status === "active" && (
        <div className="card status-banner">
          <span className="badge badge-active">Активна</span>
          <span className="status-banner-text">
            {user.subscription.planLabel} · до{" "}
            {user.subscription.endsAt}
          </span>
        </div>
      )}

      {catalog.tariffs.map((tariff) => (
        <button
          key={tariff.id}
          type="button"
          className={`card plan-card tariff-card ${planType === tariff.id ? "selected" : ""}`}
          onClick={() => {
            setPlanType(tariff.id);
            if (tariff.id === "personal") setExtraDevices(0);
          }}
        >
          <div className="tariff-name">{tariff.name}</div>
          <div className="tariff-sub">{tariff.subtitle}</div>
          {tariff.id === "basic" && (
            <div className="tariff-meta">от {tariff.periods[1]} ₽ / мес</div>
          )}
          {tariff.id === "personal" && (
            <div className="tariff-meta">от {tariff.periods[1]} ₽ / мес</div>
          )}
        </button>
      ))}

      {planType && (
        <div className="card">
          <h3 className="section-title-sm">Срок подписки</h3>
          <div className="period-grid">
            {catalog.billingMonths.map((m) => (
              <button
                key={m}
                type="button"
                className={`period-chip ${months === m ? "active" : ""}`}
                onClick={() => setMonths(m)}
              >
                {m === 1 ? "1 мес" : m === 3 ? "3 мес" : m === 6 ? "6 мес" : "1 год"}
              </button>
            ))}
          </div>
        </div>
      )}

      {planType === "basic" && (
        <div className="card">
          <h3 className="section-title-sm">Дополнительные устройства</h3>
          <p className="hint-text">
            +{catalog.extraDevicePricePerMonth} ₽ / устройство / месяц (сверх 1 в тарифе)
          </p>
          <div className="device-stepper">
            <button
              type="button"
              className="stepper-btn"
              disabled={extraDevices <= 0}
              onClick={() => setExtraDevices((n) => Math.max(0, n - 1))}
            >
              −
            </button>
            <span className="stepper-value">+{extraDevices}</span>
            <button
              type="button"
              className="stepper-btn"
              disabled={extraDevices >= 10}
              onClick={() => setExtraDevices((n) => Math.min(10, n + 1))}
            >
              +
            </button>
          </div>
        </div>
      )}

      {total != null && (
        <div className="card card-glass total-card">
          <span>Итого (демо)</span>
          <span className="total-price">{total} ₽</span>
        </div>
      )}

      <button
        type="button"
        className="btn-primary"
        disabled={!planType || !months || loading}
        onClick={handleBuy}
      >
        {loading ? "Оформление…" : "Оформить подписку"}
      </button>

      {message && <p className="message-text">{message}</p>}
    </>
  );
}
