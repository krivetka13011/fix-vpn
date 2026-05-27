# Подключение Supabase к FIX VPN

Я не могу войти в ваш Supabase — вы создаёте проект за ~5 минут, дальше всё подключается автоматически при деплое.

---

## Шаг 1. Создать проект Supabase

1. Откройте [https://supabase.com/dashboard](https://supabase.com/dashboard) и войдите (Google / GitHub).
2. **New project**
3. Имя: `fix-vpn` (любое)
4. Пароль базы — придумайте и **сохраните** (для входа в SQL, Worker его не использует)
5. Регион — ближайший к вам (например Frankfurt)
6. **Create new project** — подождите 1–2 минуты, пока статус станет зелёным

---

## Шаг 2. Создать таблицы (база данных)

1. В проекте слева: **SQL Editor** → **New query**
2. Откройте в репозитории файл `supabase/schema.sql`, скопируйте **весь** текст
3. Вставьте в редактор Supabase → **Run** (или Ctrl+Enter)
4. Должно быть **Success** — созданы таблицы `users`, `subscriptions`, `addon_purchases`

Проверка: **Table Editor** — видны три таблицы.

---

## Шаг 3. Скопировать ключи API

1. Слева: **Project Settings** (шестерёнка) → **API**
2. Скопируйте и сохраните у себя (не в чат с ботом):

| Поле в Supabase | Секрет в GitHub |
|-----------------|-----------------|
| **Project URL** | `SUPABASE_URL` |
| **service_role** (Reveal → copy) | `SUPABASE_SERVICE_ROLE_KEY` |

Важно: берите **service_role**, не `anon` / `publishable`.  
service_role даёт полный доступ — храните только в GitHub Secrets и `.dev.vars`, никому не отправляйте.

---

## Шаг 4. Добавить секреты в GitHub

[github.com/krivetka13011/fix-vpn/settings/secrets/actions](https://github.com/krivetka13011/fix-vpn/settings/secrets/actions)

**New repository secret** для каждого:

| Name | Value |
|------|--------|
| `SUPABASE_URL` | `https://xxxxxxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | длинный JWT из service_role |
| `CLOUDFLARE_API_TOKEN` | уже есть |
| `TELEGRAM_BOT_TOKEN` | токен @FIXVPNfast_bot |

---

## Шаг 5. Деплой (подключение к Worker)

[Actions → Deploy FIX VPN → Run workflow](https://github.com/krivetka13011/fix-vpn/actions/workflows/deploy.yml)

Workflow сам запишет секреты в Cloudflare Worker и проверит:

- `supabaseOk: true` в `/api/health`
- каталог тарифов и webhook

**Live URL:** https://fix-vpn.krivetkagames.workers.dev/api/health  
В ответе должно быть: `"supabaseOk":true`

---

## Локальная разработка (по желанию)

Скопируйте `.dev.vars.example` → `.dev.vars` и вставьте те же `SUPABASE_URL` и `SUPABASE_SERVICE_ROLE_KEY`.

```powershell
cd "c:\Users\User\Downloads\FIX Vnp"
copy .dev.vars.example .dev.vars
npx wrangler dev
```

---

## Если деплой падает на supabaseOk

- SQL из `schema.sql` выполнен без ошибок
- В GitHub секреты без пробелов в начале/конце
- `SUPABASE_URL` без слэша в конце
- Использован именно **service_role**, не anon

---

## BotFather

Mini App URL: **https://fix-vpn.krivetkagames.workers.dev**
