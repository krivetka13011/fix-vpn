import { useCallback, useMemo, useState } from "react";
import type { BillingMonths, Catalog, PlanType, UserProfile } from "../types";
import { purchasePlan } from "../api/client";
import { useTelegramMainButton } from "../hooks/useTelegramMainButton";

interface Props {
  catalog: Catalog;
  user: UserProfile;
  onPurchased: () => void;
}

const PERIOD_LABELS: Record<BillingMonths, string> = {
  1: "1 мес",
  2: "2 мес",
  3: "3 мес",
  6: "6 мес",
  12: "1 год",
};

export function PlansTab({ catalog, user, onPurchased }: Props) {
  const [planType, setPlanType] = useState<PlanType | null>(null);
  const [months, setMonths] = useState<BillingMonths | null>(null);
  const [extraDevices, setExtraDevices] = useState(0);
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
          <div className="header-sub">Базовый и Про</div>
        </div>
      </header>

      {catalog.tariffs.map((tariff) => (
        <div
          key={tariff.id}
          className={`card tariff-block ${planType === tariff.id ? "selected" : ""}`}
        >
          <button
            type="button"
            className="tariff-head"
            onClick={() => {
              setPlanType(tariff.id);
              if (tariff.id === "personal") setExtraDevices(0);
            }}
          >
            <div className="tariff-name">{tariff.name}</div>
            <div className="tariff-sub">{tariff.subtitle}</div>
          </button>
          <ul className="feature-list">
            {tariff.features.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          {planType === tariff.id && (
            <>
              <div className="period-wrap">
                <span className="section-title-sm">Период</span>
                <div className="chip-grid period-row">
                  {catalog.billingMonths.map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={`chip ${months === m ? "active" : ""}`}
                      onClick={() => setMonths(m)}
                    >
                      <span>{PERIOD_LABELS[m]}</span>
                      <span className="chip-price">{tariff.periods[m]} ₽</span>
                    </button>
                  ))}
                </div>
              </div>
              {tariff.id === "basic" && (
                <div className="extra-block">
                  <span className="section-title-sm">Доп. устройства</span>
                  <p className="hint-text">
                    +{catalog.extraDevicePricePerMonth} ₽ / устройство / мес
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
            </>
          )}
        </div>
      ))}

      {total != null && (
        <div className="card total-card">
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
