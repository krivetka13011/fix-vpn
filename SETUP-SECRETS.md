# GitHub Secrets и локальный project_config.env

Проект: **fix-vpn** · репозиторий [krivetka13011/fix-vpn](https://github.com/krivetka13011/fix-vpn)

Хранилище: **Cloudflare D1** (пользователи, подписки, платежи) + **KV** (сессии бота, кэш подписок, rate limits).

---

## 1. Cloudflare API Token

[Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens) → **Create Token** → шаблон **Edit Cloudflare Workers** (или custom с правами D1 + Workers KV + Workers Scripts).

В GitHub Secret и в `project_config.env`:

| Name | Значение |
|------|----------|
| `CLOUDFLARE_API_TOKEN` | токен API |
| `CLOUDFLARE_ACCOUNT_ID` | `abd3a9f30b070ba7b27946ecb6b82945` |

Опционально (есть дефолты в `scripts/d1_utils.py`):

| Name | Значение |
|------|----------|
| `D1_DATABASE_ID` | `de753b71-e8b6-4d60-8eab-2b10ce0ed098` |
| `KV_NAMESPACE_ID` | `1d9c845eb4c54a2d9db139b05104aaf3` |

---

## 2. Остальные секреты (без изменений)

[github.com/krivetka13011/fix-vpn/settings/secrets/actions](https://github.com/krivetka13011/fix-vpn/settings/secrets/actions)

| Name | Назначение |
|------|------------|
| `TELEGRAM_BOT_TOKEN` / `CLIENT_BOT_TOKEN` | бот FIX VPN |
| `PARTNER_BOT_TOKEN` | партнёрский бот |
| `XUI_BASE_URL`, `XUI_API_TOKEN` | панель 3X-UI |
| `WEBAPP_URL` | `https://app.fixvp.xyz` |
| `E2E_TRACE_SECRET` | E2E-тесты в CI |

**Supabase больше не нужен** — секреты `SUPABASE_URL` и `SUPABASE_SERVICE_ROLE_KEY` можно удалить.

---

## 3. D1 миграции

При деплое CI выполняет:

```bash
npx wrangler d1 migrations apply fix-vpn --remote
```

Локально (из корня репозитория):

```bash
npx wrangler d1 migrations apply fix-vpn --remote
```

---

## 4. Проверка

**Health:** https://app.fixvp.xyz/api/health

Нужно:

```json
"ok": true,
"d1Ok": true,
"kvOk": true,
"clientBotOk": true
```

**Бот:** https://t.me/FIXVPNfast_bot → «FIX VPN» / «Открыть FIX VPN»

**Локальные скрипты:** скопируйте `project_config.env.example` → `project_config.env`, заполните `CLOUDFLARE_API_TOKEN` и ключи панели.

```bash
python scripts/smoke_check.py
python scripts/cleanup_for_fresh_test.py   # workflow_dispatch в Actions
```

---

## 5. Workflows (cron)

| Workflow | Что делает |
|----------|------------|
| Deploy FIX VPN | push → Worker + D1 migrate + provision |
| Provision pending VPN clients | каждые 2 мин |
| Sync panel clients | каждую минуту |
| Refresh subscription caches | каждые 15 мин → KV `subcache:` |
| Cleanup fresh test | ручной сброс D1 + панели |
| Health monitor | smoke + Telegram alert |
