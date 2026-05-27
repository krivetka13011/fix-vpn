/**
 * Устанавливает кнопку меню бота «Открыть Web App».
 * TELEGRAM_BOT_TOKEN и WEBAPP_URL в .env или переменных окружения.
 */
const token = process.env.TELEGRAM_BOT_TOKEN;
const webAppUrl = process.env.WEBAPP_URL;

if (!token || !webAppUrl) {
  console.error("Нужны TELEGRAM_BOT_TOKEN и WEBAPP_URL");
  process.exit(1);
}

const res = await fetch(
  `https://api.telegram.org/bot${token}/setChatMenuButton`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      menu_button: {
        type: "web_app",
        text: "FIX VPN",
        web_app: { url: webAppUrl },
      },
    }),
  }
);

const data = await res.json();
console.log(JSON.stringify(data, null, 2));
if (!data.ok) process.exit(1);
