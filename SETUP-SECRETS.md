# Один раз: секреты

[Секреты GitHub](https://github.com/krivetka13011/fix-vpn/settings/secrets/actions)

| Name | Value |
|------|--------|
| `CLOUDFLARE_API_TOKEN` | [Token: Edit Cloudflare Workers](https://dash.cloudflare.com/profile/api-tokens?template=editCloudflareWorkers) |
| `TELEGRAM_BOT_TOKEN` | [@BotFather](https://t.me/BotFather) → API Token |

`WEBAPP_URL` обновляется автоматически после каждого деплоя.

[Запустить деплой](https://github.com/krivetka13011/fix-vpn/actions/workflows/deploy.yml) → **Run workflow**

**Live URL** (после зелёного run, в Summary): обычно **https://fix-vpn.krivetkagames.workers.dev**

BotFather → **Configure Mini App** → тот же URL из Summary (не подставляйте URL вручную).
