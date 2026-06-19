#!/usr/bin/env python3
"""Activate trial via Mini App API and verify connect readiness."""
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
    headers = {"Content-Type": "application/json", "X-Telegram-Init-Data": init_data}
    url = f"{WORKER}{path}"
    if method == "GET":
        response = requests.get(url, headers=headers, timeout=30)
    else:
        response = requests.post(url, headers=headers, json=body or {}, timeout=90)
    return response.status_code, response.json()


def main() -> int:
    load_env("project_config.env")
    token = os.environ["CLIENT_BOT_TOKEN"].strip()
    init_data = build_init_data(token, TESTER_TG, "Krivetka1301")

    code, me0 = api("GET", "/api/me", init_data)
    sub0 = me0.get("user", {}).get("subscription", {})
    print("before", sub0.get("status"), "trialAvailable", me0.get("user", {}).get("trialAvailable"))

    if sub0.get("status") == "active":
        print("already active, skipping trial POST")
    elif me0.get("user", {}).get("trialAvailable"):
        code, trial = api("POST", "/api/trial", init_data)
        print("trial", code, trial.get("message") or trial.get("error"))
        if code != 200:
            return 1
    else:
        print("trial not available — reset tester or wait")
        return 1

    for attempt in range(1, 6):
        time.sleep(2)
        code, me = api("GET", "/api/me", init_data)
        sub = me.get("user", {}).get("subscription", {})
        print(f"poll {attempt}", {
            "status": sub.get("status"),
            "canConnect": sub.get("canConnect"),
            "isTrial": sub.get("isTrial"),
            "planLabel": sub.get("planLabel"),
        })
        if sub.get("canConnect"):
            break

    code, conn = api("GET", "/api/connect?platform=android&client=happ", init_data)
    print("connect", code, conn.get("error") or ("subId=" + str(conn.get("subId", ""))[:12]))
    if code != 200:
        return 1
    print("TRIAL+CONNECT PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
