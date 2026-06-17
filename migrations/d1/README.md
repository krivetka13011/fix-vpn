# Cloudflare D1 + KV

Хранилище FIX VPN: **D1** (постоянные данные) + **KV** (сессии и кэш).

## Первый запуск (один раз)

```bash
npx wrangler d1 create fix-vpn
npx wrangler kv namespace create FIX_VPN_KV
```

Подставьте `database_id` и `id` KV в `wrangler.toml`.

## Миграции

```bash
npx wrangler d1 migrations apply fix-vpn --remote
```

CI: шаг **Apply D1 migrations** в `deploy.yml`.

## Разделение

| D1 | KV |
|----|-----|
| users, subscriptions | bot_sessions (state, payload) |
| transactions, addon_purchases | rate limits (кнопки бота) |
| partners, requisites, promo, withdrawals | subscription payload cache |
| xui_client_inbounds, vpn_device_bindings | subscription status cache (5 мин) |
