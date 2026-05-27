# FIX VPN — 3 шага (≈3 мин)

## 1. Токен Cloudflare

[Создать API Token (шаблон Workers)](https://dash.cloudflare.com/profile/api-tokens?template=editCloudflareWorkers) → **Create Token** → скопировать токен.

## 2. Секреты GitHub

[Секреты репозитория fix-vpn](https://github.com/krivetka13011/fix-vpn/settings/secrets/actions) → **New repository secret** × 3:

| Name | Value |
|------|--------|
| `CLOUDFLARE_API_TOKEN` | токен из шага 1 |
| `CLOUDFLARE_ACCOUNT_ID` | `abd3a9f30b070ba7b27946ecb6b82945` |
| `TELEGRAM_BOT_TOKEN` | токен от [@BotFather](https://t.me/BotFather) |

## 3. Запуск деплоя

[Actions → Deploy FIX VPN → Run workflow](https://github.com/krivetka13011/fix-vpn/actions/workflows/deploy.yml) → **Run workflow**.

В логе job будет **Live URL** (`https://fix-vpn….workers.dev`).

## 4. Mini App в BotFather

[@BotFather](https://t.me/BotFather) → ваш бот → **Configure Mini App** → вставить **Live URL** из лога.

Готово. Проверка: бот → кнопка **FIX VPN**.
