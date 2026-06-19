import { useCallback, useMemo, useState } from "react";
import type { BillingMonths, Catalog, PlanType, UserProfile } from "../types";
import { activateTrial, purchasePlan } from "../api/client";
import { useTelegramMainButton } from "../hooks/useTelegramMainButton";

interface Props {
  catalog: Catalog;
  user: UserProfile;
  onPurchased: () => void | Promise<void>;
  onUserUpdate?: (user: UserProfile) => void;
  onTrialActivated?: () => void;
  onGoToProfile?: () => void;
}

type PaymentMethod = "sbp" | "crypto_usdt";

const PERIOD_LABELS: Record<BillingMonths, string> = {
  1: "1 мес",
  2: "2 мес",
  3: "3 мес",
  6: "6 мес",
  12: "1 год",
};

export function PlansTab({ catalog, user, onPurchased, onUserUpdate, onTrialActivated, onGoToProfile }: Props) {
  const [planType, setPlanType] = useState<PlanType | null>(null);
  const [months, setMonths] = useState<BillingMonths | null>(null);
  const [extraDevices, setExtraDevices] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("sbp");
  const [loading, setLoading] = useState(false);
  const [trialLoading, setTrialLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const testHint = catalog.testMode
    ? `Тест: оплата ${catalog.testCheckoutPriceRub ?? 1} ₽ · подписка ${catalog.testSubscriptionMinutes ?? 10} мин`
    : null;

  const total = useMemo(() => {
    if (!planType || !months) return null;
    if (catalog.testMode) {
      return catalog.testCheckoutPriceRub ?? 1;
    }
    const tariff = catalog.tariffs.find((t) => t.id === planType);
    if (!tariff) return null;
    const base = tariff.periods[months];
    if (planType === "personal") return base;
    return base + extraDevices * catalog.extraDevicePricePerMonth * months;
  }, [planType, months, extraDevices, catalog]);

  const handleTrial = useCallback(async () => {
    setTrialLoading(true);
    setMessage(null);
    try {
      const res = await activateTrial();
      setMessage(res.message);
      window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("medium");
      if (res.user) {
        onUserUpdate?.(res.user);
        if (res.user.subscription.canConnect) {
          onTrialActivated?.();
        } else if (res.user.subscription.connectBlockReason) {
          setMessage(res.user.subscription.connectBlockReason);
        }
      } else {
        await onPurchased();
        onTrialActivated?.();
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Не удалось активировать пробный период");
    } finally {
      setTrialLoading(false);
    }
  }, [onPurchased, onUserUpdate, onTrialActivated]);

  const handleBuy = useCallback(async () => {
    if (!planType || !months) return;
    setLoading(true);
    setMessage(null);
    try {
      const res = await purchasePlan({
        planType,
        billingMonths: months,
        extraDevices: planType === "basic" ? extraDevices : 0,
        paymentMethod,
      });
      setMessage(res.message);
      window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("medium");
      const tg = window.Telegram?.WebApp;
      if (tg?.openLink) {
        tg.openLink(res.paymentUrl);
      } else {
        window.open(res.paymentUrl, "_blank", "noopener,noreferrer");
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Ошибка оплаты");
    } finally {
      setLoading(false);
    }
  }, [planType, months, extraDevices, paymentMethod]);

  useTelegramMainButton(
    "Оплатить",
    planType != null && months != null,
    handleBuy,
    loading
  );

  const showTrial = user.trialAvailable === true;
  const trialEnded =
    user.subscription.status === "expired" && Boolean(user.subscription.isTrial);
  const activeTrial =
    user.subscription.status === "active" && Boolean(user.subscription.isTrial);
  const devicesUsed = user.subscription.devicesUsed ?? 0;
  const devicesMax = user.subscription.devicesMax ?? 1;
  const trialAtLimit =
    activeTrial &&
    user.subscription.canConnect !== true &&
    devicesUsed >= devicesMax;

  return (
    <>
      <section className="page-hero">
        <h1 className="page-title">Тарифы</h1>
        <p className="page-desc">
          {testHint ??
            "Базовый — от 199 ₽/мес · Про — личный сервер"}
        </p>
      </section>

      <div className="stack">
        {trialEnded && (
          <p className="toast">
            Пробный период завершён. Выберите тариф ниже и оплатите подписку.
          </p>
        )}
        {trialAtLimit && (
          <>
            <p className="toast">
              Пробный период активен, но лимит {devicesUsed}/{devicesMax} занят.
              Сбросьте подключение в профиле, затем подключитесь во вкладке «Помощь».
            </p>
            {onGoToProfile && (
              <button type="button" className="btn btn-ghost" onClick={onGoToProfile}>
                <span className="material-symbols-outlined">devices</span>
                Перейти в профиль → сбросить
              </button>
            )}
          </>
        )}
        {activeTrial && user.subscription.canConnect === true && (
          <p className="toast">
            Пробный период активен — откройте «Помощь» и нажмите «Подключиться».
          </p>
        )}
        {showTrial && (
          <button
            type="button"
            className="btn btn-fill btn-pill trial-top-btn"
            disabled={trialLoading}
            onClick={handleTrial}
          >
            {trialLoading
              ? "Активация…"
              : catalog.trialDurationMinutes
                ? `Пробный период · ${catalog.trialDurationMinutes} мин`
                : "Пробный период"}
          </button>
        )}

        {catalog.tariffs.map((tariff) => {
          const selected = planType === tariff.id;
          const monthly = tariff.periods[1];
          return (
            <article
              key={tariff.id}
              className={`glass-panel tariff-card ${selected ? "selected" : ""} ${tariff.id === "personal" ? "popular" : ""}`}
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
              {tariff.id === "personal" && (
                <span className="tariff-badge-pop">Про</span>
              )}
              <div className="tariff-inner">
                <div className="tariff-head">
                  <div>
                    <div className="tariff-name">{tariff.name}</div>
                    <div className="tariff-sub">{tariff.subtitle}</div>
                  </div>
                  <div className="tariff-price">
                    <div className="tariff-price-value">{monthly} ₽</div>
                    <div className="tariff-price-period">/ мес</div>
                  </div>
                </div>
                <div className="tariff-divider" />
                <ul className="feature-list">
                  {tariff.features.map((f) => (
                    <li key={f}>
                      <span className="material-symbols-outlined filled">
                        check_circle
                      </span>
                      {f}
                    </li>
                  ))}
                </ul>
              </div>

              {selected && (
                <div className="tariff-expand">
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
                      <div className="tariff-divider" />
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
                        <div>
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

                  <div className="tariff-divider" />
                  <p className="section-label">Способ оплаты</p>
                  <div className="chip-row">
                    <button
                      type="button"
                      className={`chip ${paymentMethod === "sbp" ? "active" : ""}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPaymentMethod("sbp");
                      }}
                    >
                      📱 СБП
                    </button>
                    <button
                      type="button"
                      className={`chip ${paymentMethod === "crypto_usdt" ? "active" : ""}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPaymentMethod("crypto_usdt");
                      }}
                    >
                      💎 USDT
                    </button>
                  </div>
                </div>
              )}
            </article>
          );
        })}

        {total != null && (
          <div className="glass-panel total-bar">
            <span className="total-label">К оплате</span>
            <span className="total-price">{total} ₽</span>
          </div>
        )}

        <button
          type="button"
          className="btn btn-fill btn-pill"
          disabled={!planType || !months || loading}
          onClick={handleBuy}
        >
          {loading ? "Открываем оплату…" : "Оплатить"}
        </button>

        {message && <p className="toast">{message}</p>}
      </div>
    </>
  );
}
