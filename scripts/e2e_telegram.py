"""End-to-end bot flow test — simulates Telegram taps via webhook + captures bot replies.

Dry-run mode does not spam your chat; results are returned as JSON trace.
Requires E2E_TRACE_SECRET on Worker (same value in project_config.env).

  python scripts/e2e_telegram.py
  python scripts/e2e_telegram.py --notify   # send PASS/FAIL summary to your Telegram
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import uuid

import requests

DEFAULT_WORKER = "https://fix-vpn.krivetkagames.workers.dev"
DEFAULT_TESTER_TG = 1159166497


def load_env(path: str = "project_config.env") -> None:
    if not os.path.isfile(path):
        raise RuntimeError(f"missing {path} — copy from project_config.env.example")
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


def sb_get(path: str) -> list:
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    base = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1/"
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    response = requests.get(base + path, headers=headers, timeout=30)
    response.raise_for_status()
    return response.json()


class BotSession:
    def __init__(self, worker: str, secret: str, tg_id: int, username: str):
        self.worker = worker.rstrip("/")
        self.secret = secret
        self.tg_id = tg_id
        self.username = username
        self.chat_id = tg_id
        self.message_id = 900_000 + (tg_id % 100_000)
        self.traces: list[dict] = []

    def _headers(self) -> dict[str, str]:
        return {
            "Content-Type": "application/json",
            "X-Fix-Vpn-E2E": self.secret,
            "X-Fix-Vpn-E2E-Dry": "1",
        }

    def post_update(self, update: dict) -> dict:
        response = requests.post(
            f"{self.worker}/api/webhook/client",
            headers=self._headers(),
            json=update,
            timeout=60,
        )
        if response.status_code >= 500:
            raise RuntimeError(f"webhook HTTP {response.status_code}: {response.text[:300]}")
        try:
            payload = response.json()
        except Exception:
            payload = {"ok": True, "raw": response.text}
        if payload.get("trace"):
            self.traces.append(payload["trace"])
        return payload

    def user(self) -> dict:
        return {
            "id": self.tg_id,
            "is_bot": False,
            "first_name": "E2E",
            "username": self.username,
            "language_code": "ru",
        }

    def message_start(self, text: str) -> None:
        self.post_update(
            {
                "update_id": int(uuid.uuid4().int % 10_000_000),
                "message": {
                    "message_id": self.message_id,
                    "chat": {"id": self.chat_id, "type": "private"},
                    "from": self.user(),
                    "text": text,
                },
            }
        )

    def callback(self, data: str) -> None:
        self.post_update(
            {
                "update_id": int(uuid.uuid4().int % 10_000_000),
                "callback_query": {
                    "id": str(uuid.uuid4()),
                    "from": self.user(),
                    "data": data,
                    "message": {
                        "message_id": self.message_id,
                        "chat": {"id": self.chat_id, "type": "private"},
                    },
                },
            }
        )


def trace_texts(traces: list[dict]) -> str:
    chunks: list[str] = []
    for block in traces:
        for entry in block.get("entries") or []:
            body = entry.get("body") or {}
            if isinstance(body.get("text"), str):
                chunks.append(body["text"])
    return "\n".join(chunks)


def trace_markup_urls(traces: list[dict]) -> list[str]:
    urls: list[str] = []
    for block in traces:
        for entry in block.get("entries") or []:
            body = entry.get("body") or {}
            markup = body.get("reply_markup") or {}
            for row in markup.get("inline_keyboard") or []:
                if not isinstance(row, list):
                    continue
                for btn in row:
                    if isinstance(btn, dict) and btn.get("url"):
                        urls.append(str(btn["url"]))
    return urls


def subscription_ok(body: str) -> bool:
    text = re.sub(r"^#hide-settings\s*:\s*1\s*\n?", "", body.strip(), flags=re.I)
    return bool(re.search(r"^(vless|vmess|trojan|hysteria2)://", text, re.I | re.M))


def assert_no_bad_phrases(text: str, failures: list[str]) -> None:
    bad = [
        "1–2 мин",
        "1-2 мин",
        "подождите 1",
        "клиент не подготовлен",
        "subscription unavailable",
        "Invalid subscription",
    ]
    lower = text.lower()
    for phrase in bad:
        if phrase.lower() in lower:
            failures.append(f"bot text contains «{phrase}»")


def send_notify(text: str, chat_id: int) -> bool:
    token = os.environ.get("CLIENT_BOT_TOKEN") or os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token:
        return False
    response = requests.post(
        f"https://api.telegram.org/bot{token}/sendMessage",
        json={"chat_id": chat_id, "text": text, "parse_mode": "HTML"},
        timeout=20,
    )
    return bool(response.json().get("ok"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--notify", action="store_true")
    parser.add_argument("--worker", default=os.environ.get("WEBAPP_URL", DEFAULT_WORKER))
    parser.add_argument("--tester-tg", type=int, default=DEFAULT_TESTER_TG)
    args = parser.parse_args()

    load_env()
    secret = os.environ.get("E2E_TRACE_SECRET", "").strip()
    if not secret:
        raise RuntimeError("E2E_TRACE_SECRET missing in project_config.env")

    user_rows = sb_get(
        f"users?telegram_id=eq.{args.tester_tg}&select=id,username&limit=1"
    )
    if not user_rows:
        print("FAIL: tester user not in DB — press /start in bot first")
        return 1
    username = user_rows[0].get("username") or "tester"

    sub_rows = sb_get(
        f"subscriptions?user_id=eq.{user_rows[0]['id']}&select=status,xray_sub_id&limit=1"
    )
    sub = sub_rows[0] if sub_rows else {}
    if sub.get("status") != "active":
        print("FAIL: tester has no active subscription — activate trial first")
        return 1

    sub_id = str(sub.get("xray_sub_id") or "").strip()
    failures: list[str] = []
    bot = BotSession(args.worker, secret, args.tester_tg, username)

    print("E2E Telegram flow (dry-run)")
    bot.message_start("/start")
    bot.callback("c:menu")
    bot.callback("c:profile")
    bot.callback("c:connect")
    bot.callback("c:os:android")

    all_text = trace_texts(bot.traces)
    assert_no_bad_phrases(all_text, failures)

    if "Подключить VPN" not in all_text and "Выберите ОС" not in all_text:
        if "FIX VPN" not in all_text:
            failures.append("menu/profile flow did not return expected bot screens")

    urls = trace_markup_urls(bot.traces)
    happ_urls = [u for u in urls if "/api/redirect/happ" in u]
    if not happ_urls:
        failures.append("android connect: no Happ redirect URL in bot keyboard")
    else:
        redirect = requests.get(happ_urls[-1], timeout=30)
        if redirect.status_code != 200 or "happ://crypt" not in redirect.text:
            failures.append(f"happ redirect broken HTTP {redirect.status_code}")

    worker_sub = requests.get(f"{args.worker.rstrip('/')}/api/sub/{sub_id}", timeout=30)
    if not subscription_ok(worker_sub.text):
        failures.append(
            f"subscription body invalid HTTP {worker_sub.status_code} "
            f"preview={worker_sub.text[:80]!r}"
        )

    print("\n--- Bot messages (trace) ---")
    print(all_text[:2000] or "(empty)")
    print("\n--- Happ URLs ---")
    for url in happ_urls:
        print(url)

    if failures:
        print("\nFAIL:")
        for item in failures:
            print(" -", item)
        result = "FAIL"
        code = 1
    else:
        print("\nE2E PASS — bot flow + subscription + Happ redirect OK")
        result = "PASS"
        code = 0

    if args.notify:
        chat = int(os.environ.get("SMOKE_NOTIFY_CHAT_ID", str(args.tester_tg)))
        summary = f"<b>FIX VPN E2E</b> {result}\n\n"
        if failures:
            summary += "\n".join(f"• {f}" for f in failures)
        else:
            summary += "Бот, подписка и Happ redirect проверены автоматически."
        send_notify(summary, chat)

    return code


if __name__ == "__main__":
    sys.exit(main())
