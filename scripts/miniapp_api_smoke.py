#!/usr/bin/env python3
"""Smoke-test Mini App API with signed Telegram initData."""
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


def api(method: str, path: str, init_data: str, body: dict | None = None) -> tuple[int, dict]:
    headers = {
        "Content-Type": "application/json",
        "X-Telegram-Init-Data": init_data,
    }
    url = f"{WORKER}{path}"
    if method == "GET":
        response = requests.get(url, headers=headers, timeout=30)
    else:
        response = requests.post(url, headers=headers, json=body or {}, timeout=60)
    try:
        payload = response.json()
    except Exception:
        payload = {"raw": response.text[:500]}
    return response.status_code, payload


def main() -> int:
    load_env("project_config.env")
    token = os.environ.get("CLIENT_BOT_TOKEN", "").strip()
    if not token:
        print("FAIL: CLIENT_BOT_TOKEN missing")
        return 1

    init_data = build_init_data(token, TESTER_TG, "Krivetka1301")
    failures: list[str] = []

    code, catalog = api("GET", "/api/catalog", init_data)
    print("catalog", code, {k: catalog.get(k) for k in ("testMode", "trialDurationMinutes", "testSubscriptionMinutes")})
    if code != 200:
        failures.append(f"catalog HTTP {code}")
    elif catalog.get("trialDurationMinutes") != 5:
        failures.append(f"trialDurationMinutes={catalog.get('trialDurationMinutes')} expected 5")
    elif catalog.get("testSubscriptionMinutes") != 10:
        failures.append(f"testSubscriptionMinutes={catalog.get('testSubscriptionMinutes')} expected 10")

    code, me = api("GET", "/api/me", init_data)
    sub = (me.get("user") or {}).get("subscription") or {}
    print("me", code, {
        "status": sub.get("status"),
        "trialAvailable": me.get("user", {}).get("trialAvailable"),
        "canConnect": sub.get("canConnect"),
        "connectBlockReason": sub.get("connectBlockReason"),
        "planLabel": sub.get("planLabel"),
        "devicesUsed": sub.get("devicesUsed"),
        "devicesMax": sub.get("devicesMax"),
    })
    if code != 200:
        failures.append(f"/api/me HTTP {code}: {me.get('error')}")
    elif sub.get("status") == "active":
        used = sub.get("devicesUsed") or 0
        max_dev = sub.get("devicesMax") or 1
        if used >= max_dev and sub.get("canConnect"):
            failures.append("canConnect true while device limit reached")

    code, conn = api("GET", "/api/connect?platform=android&client=happ", init_data)
    print("connect", code, {"ok": conn.get("ok"), "error": conn.get("error"), "hasSubId": bool(conn.get("subId"))})
    if sub.get("status") == "active":
        used = sub.get("devicesUsed") or 0
        max_dev = sub.get("devicesMax") or 1
        if used >= max_dev and code == 400:
            print("connect blocked at device limit (expected)")
        elif code != 200:
            failures.append(f"connect failed for active sub: {conn.get('error')}")
    if sub.get("status") != "active" and code == 200:
        failures.append("connect succeeded but subscription not active")

    if failures:
        print("\nFAIL:")
        for item in failures:
            print(" -", item)
        return 1

    print("\nSMOKE PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
