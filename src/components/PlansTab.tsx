import { useCallback, useMemo, useState } from "react";
import type { BillingMonths, Catalog, PlanType } from "../types";
import { purchasePlan } from "../api/client";
import { useTelegramMainButton } from "../hooks/useTelegramMainButton";

interface Props {
  catalog: Catalog;
  onPurchased: () => void;
}

const PERIOD_LABELS: Record<BillingMonths, string> = {
  1: "1 мес",
  2: "2 мес",
  3: "3 мес",
  6: "6 мес",
  12: "1 год",
};

export function PlansTab({ catalog, onPurchased }: Props) {
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
      <header className="page-head">
        <p className="page-eyebrow">Подписка</p>
        <h1 className="page-title">Тарифы</h1>
        <p className="page-desc">Базовый — от 199 ₽/мес · Про — личный сервер</p>
      </header>

      <div className="stack">
        {catalog.tariffs.map((tariff) => {
          const selected = planType === tariff.id;
          return (
            <article
              key={tariff.id}
              className={`surface tariff ${selected ? "selected" : ""}`}
              onClick={() => {
                setPlanType(tariff.id);
                if (tariff.id === "personal") setExtraDevices(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setPlanType(tariff.id);
                  if (tariff.id === "personal") setExtraDevices(0);
                }
              }}
              role="button"
              tabIndex={0}
            >
              <div className="tariff-inner">
                {tariff.id === "personal" && (
                  <span className="tariff-badge">Про</span>
                )}
                <div className="tariff-top">
                  <div className="tariff-radio" aria-hidden>
                    <span className="tariff-radio-dot" />
                  </div>
                  <div className="tariff-info">
                    <div className="tariff-name">{tariff.name}</div>
                    <div className="tariff-sub">{tariff.subtitle}</div>
                  </div>
                </div>
                <ul className="feature-list">
                  {tariff.features.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </div>

              {selected && (
                <div className="tariff-expand">
                  <div className="divider" />
                  <p className="section-label">Период</p>
                  <div className="chip-row periods">
                    {catalog.billingMonths.map((m) => (
                      <button
                        key={m}
                        type="button"
                        className={`chip period ${months === m ? "active" : ""}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setMonths(m);
                        }}
                      >
                        <span>{PERIOD_LABELS[m]}</span>
                        <span className="chip-price">{tariff.periods[m]} ₽</span>
                      </button>
                    ))}
                  </div>

                  {tariff.id === "basic" && (
                    <>
                      <div className="divider" />
                      <p className="section-label">Доп. устройства</p>
                      <p className="hint-text">
                        +{catalog.extraDevicePricePerMonth} ₽ за устройство в месяц
                      </p>
                      <div className="device-stepper">
                        <button
                          type="button"
                          className="stepper-btn"
                          disabled={extraDevices <= 0}
                          onClick={(e) => {
                            e.stopPropagation();
                            setExtraDevices((n) => Math.max(0, n - 1));
                          }}
                        >
                          −
                        </button>
                        <div className="stepper-meta">
                          <div className="stepper-value">+{extraDevices}</div>
                          <div className="stepper-hint">к тарифу</div>
                        </div>
                        <button
                          type="button"
                          className="stepper-btn"
                          disabled={extraDevices >= 10}
                          onClick={(e) => {
                            e.stopPropagation();
                            setExtraDevices((n) => Math.min(10, n + 1));
                          }}
                        >
                          +
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </article>
          );
        })}

        {total != null && (
          <div className="total-bar">
            <span className="total-label">Итого (демо)</span>
            <span className="total-price">{total} ₽</span>
          </div>
        )}

        <button
          type="button"
          className="btn btn-fill"
          disabled={!planType || !months || loading}
          onClick={handleBuy}
        >
          {loading ? "Оформление…" : "Оформить подписку"}
        </button>

        {message && <p className="toast">{message}</p>}
      </div>
    </>
  );
}
