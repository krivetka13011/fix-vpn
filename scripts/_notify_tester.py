import os
import requests

with open("project_config.env", encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ[k.strip()] = v.strip()

token = os.environ["CLIENT_BOT_TOKEN"]
chat = 1159166497
    text = (
        "<b>FIX VPN: привязка исправлена</b>\n\n"
        "Ваша постоянная ссылка:\n"
        f"<code>https://fixvp.xyz:2096/sub/0n5regyvk6mang59</code>\n\n"
        "1. Удалите ВСЕ старые Encrypted в Happ.\n"
        "2. Бот -> Подключить VPN -> Happ.\n"
        "3. Обновите подписку (круговая стрелка).\n\n"
        "Новые клиенты больше не создаются для вашего аккаунта."
    )
r = requests.post(
    f"https://api.telegram.org/bot{token}/sendMessage",
    json={"chat_id": chat, "text": text, "parse_mode": "HTML"},
    timeout=20,
)
print(r.json())
