#!/usr/bin/env python3
"""Test Platega checkout from Mini App API."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys
import time
import urllib.parse

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from d1_utils import load_env

WORKER = os.environ.get("WEBAPP_URL", "https://app.fixvp.xyz").rstrip("/")
TESTER_TG = int(os.environ.get("TESTER_TELEGRAM_ID", "1159166497"))


def build_init_data(bot_token: str, user_id: int, username: str) -> str:
    user = json.dumps(
        {"id": user_id, "first_name": "Smoke", "username": username},
        separators=(",", ":"),
    )
    auth_date = str(int(time.time()))
    pairs = {"auth_date": auth_date, "user": user}
    data_check = "\n".join(f"{k}={pairs[k]}" for k in sorted(pairs))
    secret = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    signature = hmac.new(secret, data_check.encode(), hashlib.sha256).hexdigest()
    return urllib.parse.urlencode({**pairs, "hash": signature})


def main() -> int:
    load_env("project_config.env")
    token = os.environ["CLIENT_BOT_TOKEN"].strip()
    init_data = build_init_data(token, TESTER_TG, "Krivetka1301")
    headers = {"Content-Type": "application/json", "X-Telegram-Init-Data": init_data}
    response = requests.post(
        f"{WORKER}/api/purchase",
        headers=headers,
        json={
            "planType": "basic",
            "billingMonths": 1,
            "extraDevices": 0,
            "paymentMethod": "sbp",
        },
        timeout=60,
    )
    print("purchase", response.status_code, response.text[:500])
    if response.status_code != 200:
        return 1
    data = response.json()
    if not data.get("paymentUrl"):
        print("FAIL: no paymentUrl")
        return 1
    print("CHECKOUT PASS", data.get("amount"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
