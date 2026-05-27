# Локальный деплой (после wrangler login в этом же терминале)
Set-Location $PSScriptRoot\..
$env:XDG_CONFIG_HOME = "$env:APPDATA\xdg.config"

Write-Host "Building..." -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Deploying to Cloudflare..." -ForegroundColor Cyan
npx wrangler deploy
if ($LASTEXITCODE -ne 0) {
  Write-Host "Сначала: npx wrangler login" -ForegroundColor Yellow
  exit $LASTEXITCODE
}

Write-Host "Готово. URL смотрите выше (https://fix-vpn....workers.dev)" -ForegroundColor Green
Write-Host "Затем: npm run bot:menu (нужны TELEGRAM_BOT_TOKEN и WEBAPP_URL в env)" -ForegroundColor Gray
