# Один раз: секреты для автодеплоя

Откройте: **https://github.com/krivetka13011/fix-vpn/settings/secrets/actions**

Добавьте 3 секрета:

| Имя | Значение |
|-----|----------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → Create Token → шаблон **Edit Cloudflare Workers** |
| `CLOUDFLARE_ACCOUNT_ID` | `abd3a9f30b070ba7b27946ecb6b82945` |
| `TELEGRAM_BOT_TOKEN` | токен от [@BotFather](https://t.me/BotFather) |

После сохранения: **Actions** → **Deploy FIX VPN** → **Run workflow** (или любой `git push`).

В [@BotFather](https://t.me/BotFather) → ваш бот → **Configure Mini App** → URL Worker (появится в логе деплоя, обычно `https://fix-vpn.<ваш-subdomain>.workers.dev`).
