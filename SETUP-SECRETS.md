# Где взять ссылки и ключи Supabase (новый интерфейс)

Проект: **fix-vpn** · организация **krivetka13011**

---

## 1. Project URL (для `SUPABASE_URL`)

Слева в меню проекта:

**Settings** → прокрутите блок **Integrations** → **Data API**

Там будет **Project URL**, например:

`https://xxxxxxxx.supabase.co`

Можно скопировать и с хвостом `/rest/v1/` — приложение обрежет само.

В GitHub Secret **`SUPABASE_URL`** вставьте:

`https://dtxdbni*****dcryst.supabase.co`

(без `/rest/v1/` — так надёжнее)

Если в Data API пусто: **Settings** → **General** → вверху **Reference ID** / ссылка на API — или кнопка **Connect** вверху страницы проекта.

---

## 2. Секретный ключ (для `SUPABASE_SERVICE_ROLE_KEY`)

Вы уже на нужной странице: **Settings** → **API Keys**.

Нужен блок **Secret keys** (не Publishable):

| Блок | Нужен? |
|------|--------|
| **Publishable key** (`sb_publishable_...`) | Нет — только для браузера |
| **Secret keys** (`sb_secret_...`) | **Да** |

Действия:

1. Строка **default** в **Secret keys**
2. Иконка глаза **Reveal**
3. **Copy**
4. GitHub Secret **`SUPABASE_SERVICE_ROLE_KEY`**

---

## 3. GitHub Secrets

[github.com/krivetka13011/fix-vpn/settings/secrets/actions](https://github.com/krivetka13011/fix-vpn/settings/secrets/actions)

| Name | Что вставить |
|------|----------------|
| `SUPABASE_URL` | URL из Data API |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret key (`sb_secret_...`) |

---

## 4. Подключить Worker

[Actions → Connect Supabase to Worker → Run workflow](https://github.com/krivetka13011/fix-vpn/actions/workflows/connect-supabase.yml)

---

## 5. Проверка

https://fix-vpn.krivetkagames.workers.dev/api/health  

Нужно: `"supabaseOk": true`

---

## Таблицы

**Table Editor** → `users`, `subscriptions`, `addon_purchases`

Если нет: **SQL Editor** → `supabase/schema.sql` → Run
