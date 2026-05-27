# FIX VPN — Telegram Mini App

Мини-приложение Telegram для продажи VPN-подписок. Покупка и аккаунт — только в Web App, бот открывает интерфейс (без командной покупки).

## Стек

- **Frontend:** React + Vite, тёмная тема под логотип FIX VPN
- **Backend:** Cloudflare Worker + KV (`USERS_KV`)
- **Бот:** webhook `/api/webhook/telegram`, кнопка Web App

## Вкладки

1. **Главная** — статус, инструкция, кнопка покупки  
2. **Подписки** — тарифы 1 / 3 / 6 / 12 месяцев (демо-оплата)  
3. **Профиль** — фото и имя из Telegram, статус подписки (раскрывается: тариф, даты, VPN-ключ)

## Быстрый старт

### 1. Зависимости

```bash
npm install
```

### 2. Cloudflare KV

```bash
npx wrangler kv namespace create USERS_KV
npx wrangler kv namespace create USERS_KV --preview
```

Подставьте `id` и `preview_id` в `wrangler.toml`.

### 3. Секреты (токен **не** коммитить в git)

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
```

Создайте `.dev.vars` (см. `.dev.vars.example`) для локальной разработки.

### 4. URL приложения

После первого деплоя обновите `WEBAPP_URL` в `wrangler.toml` и:

```bash
npx wrangler secret put WEBAPP_URL
```

### 5. Деплой

```bash
npm run deploy
```

### 6. Webhook и кнопка меню

```bash
# Webhook (замените YOUR_WORKER на ваш workers.dev URL)
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://YOUR_WORKER.workers.dev/api/webhook/telegram"

# Кнопка «FIX VPN» в меню чата
set TELEGRAM_BOT_TOKEN=...
set WEBAPP_URL=https://YOUR_WORKER.workers.dev
npm run bot:menu
```

В [@BotFather](https://t.me/BotFather): **Bot Settings → Menu Button → Configure** — URL того же Worker.

**Mini App:** Bot Settings → Configure Mini App → укажите тот же `WEBAPP_URL`.

## Локальная разработка

Терминал 1:

```bash
npm run build
npx wrangler dev
```

Терминал 2 (опционально, только UI):

```bash
npm run dev
```

Полный API + UI в Telegram тестируется через `wrangler dev` и туннель или после деплоя.

## Репозиторий и автодеплой

- **GitHub:** https://github.com/krivetka13011/fix-vpn  
- **Автодеплой:** каждый `git push` в `master` / `main` → GitHub Actions → Cloudflare Workers  

Один раз добавьте секреты (см. `SETUP-SECRETS.md`), затем деплой идёт без вашего участия.

## Безопасность

- Токен бота храните только в Wrangler Secrets / `.dev.vars` (в `.gitignore`).
- Если токен попал в чат — отзовите в BotFather и выпустите новый.

## Дальше

- [ ] Реальная оплата (ЮKassa / Stars / crypto)  
- [ ] Выдача ключей с VPN-панели  
- [ ] Проверка истечения подписки по cron
