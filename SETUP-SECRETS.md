# Подключение Supabase к FIX VPN

Привязка Supabase к GitHub **не подключает** Cloudflare Worker сама. Нужны ещё 2 секрета в GitHub и один запуск workflow.

Текущий статус можно проверить:  
https://fix-vpn.krivetkagames.workers.dev/api/health  
Нужно: `"supabaseOk":true`

---

## Шаг 1. Таблицы в Supabase

**Вариант A** — привязка репозитория (у вас уже есть):  
Supabase Dashboard → проект → **Database** → **Migrations** — должна примениться миграция из `supabase/migrations/`.

**Вариант B** — вручную: **SQL Editor** → вставить `supabase/schema.sql` → **Run**.

Проверка: **Table Editor** → `users`, `subscriptions`, `addon_purchases`.

---

## Шаг 2. Ключи в GitHub Secrets

[github.com/krivetka13011/fix-vpn/settings/secrets/actions](https://github.com/krivetka13011/fix-vpn/settings/secrets/actions)

Supabase → **Project Settings** → **API**:

| GitHub Secret | Откуда в Supabase |
|---------------|-------------------|
| `SUPABASE_URL` | Project URL (`https://xxxxx.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | **service_role** (кнопка Reveal) |

Также должны быть: `CLOUDFLARE_API_TOKEN`, `TELEGRAM_BOT_TOKEN`.

Имена секретов **точно** как в таблице (не `SUPABASE_KEY` и не anon-ключ).

---

## Шаг 3. Подключить Worker (без полного деплоя)

[Actions → Connect Supabase to Worker → Run workflow](https://github.com/krivetka13011/fix-vpn/actions/workflows/connect-supabase.yml)

Или полный деплой: [Deploy FIX VPN → Run workflow](https://github.com/krivetka13011/fix-vpn/actions/workflows/deploy.yml)

После успеха снова откройте `/api/health` — `supabaseOk: true`.

---

## Частые ошибки

| Симптом | Решение |
|---------|---------|
| `supabaseOk: false` | Нет секретов в GitHub или не запущен Connect Supabase |
| Деплой красный на Verify | Добавьте `SUPABASE_*` в GitHub, запустите **Connect Supabase** |
| 503 Database not configured | То же — секреты не попали в Worker |
| Таблиц нет | Выполните SQL или дождитесь миграции из `supabase/migrations/` |

---

## BotFather

Mini App: **https://fix-vpn.krivetkagames.workers.dev**
