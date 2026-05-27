# Секреты и Supabase

## 1. Supabase

[Supabase Dashboard](https://supabase.com/dashboard) → проект → **SQL Editor** → выполнить файл `supabase/schema.sql`.

**Settings → API:** скопировать **Project URL** и **service_role** key (не anon).

## 2. GitHub Secrets

[Секреты](https://github.com/krivetka13011/fix-vpn/settings/secrets/actions)

| Name | Value |
|------|--------|
| `CLOUDFLARE_API_TOKEN` | [Cloudflare Workers token](https://dash.cloudflare.com/profile/api-tokens?template=editCloudflareWorkers) |
| `TELEGRAM_BOT_TOKEN` | [@BotFather](https://t.me/BotFather) → @FIXVPNfast_bot |
| `SUPABASE_URL` | `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role из Supabase |

## 3. Деплой

[Actions → Deploy FIX VPN → Run workflow](https://github.com/krivetka13011/fix-vpn/actions/workflows/deploy.yml)

Live URL: **https://fix-vpn.krivetkagames.workers.dev**

BotFather → Mini App → тот же URL.
