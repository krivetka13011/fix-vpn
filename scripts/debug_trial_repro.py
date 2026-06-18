"""Reproduce trial flow via production webhook; write NDJSON to debug-381494.log."""
from __future__ import annotations

import json
import subprocess
import sys
import time
import uuid
from pathlib import Path

import requests

LOG_PATH = Path(__file__).resolve().parents[1] / "debug-381494.log"
WORKER = "https://app.fixvp.xyz"
TG_ID = 1159166497


def log(hypothesis_id: str, location: str, message: str, data: dict | None = None) -> None:
    entry = {
        "sessionId": "381494",
        "hypothesisId": hypothesis_id,
        "location": location,
        "message": message,
        "data": data or {},
        "timestamp": int(time.time() * 1000),
        "runId": "repro-script",
    }
    with LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
    print(json.dumps(entry, ensure_ascii=False))


def wrangler_d1(sql: str) -> list[dict]:
    proc = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "fix-vpn", "--remote", "--json", "--command", sql],
        cwd=str(Path(__file__).resolve().parents[1]),
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr or proc.stdout)
    payload = json.loads(proc.stdout)
    for block in payload:
        if block.get("results"):
            return list(block["results"])
    return []


def fetch_sub_state() -> dict:
    rows = wrangler_d1(
        f"SELECT s.status, s.is_trial, s.xray_sub_id, s.client_email, s.expires_at "
        f"FROM subscriptions s INNER JOIN users u ON u.id = s.user_id "
        f"WHERE u.telegram_id = {TG_ID} LIMIT 1"
    )
    return rows[0] if rows else {}


def post_webhook(payload: dict) -> tuple[int, str, int]:
    t0 = time.time()
    response = requests.post(f"{WORKER}/api/webhook/client", json=payload, timeout=90)
    return response.status_code, response.text[:200], int((time.time() - t0) * 1000)


def main() -> int:
    if LOG_PATH.exists():
        LOG_PATH.unlink()

    log("D", "repro:before", "db_state", fetch_sub_state())

    message_id = 900_001
    user = {"id": TG_ID, "is_bot": False, "first_name": "Debug", "username": "Krivetka1301", "language_code": "ru"}

    code, body, ms = post_webhook(
        {
            "update_id": int(uuid.uuid4().int % 10_000_000),
            "message": {
                "message_id": message_id,
                "chat": {"id": TG_ID, "type": "private"},
                "from": user,
                "text": "/start",
            },
        }
    )
    log("G", "repro:/start", "webhook_response", {"http": code, "body": body, "ms": ms})

    time.sleep(40)
    log("D", "repro:after_start", "db_state", fetch_sub_state())

    code2, body2, ms2 = post_webhook(
        {
            "update_id": int(uuid.uuid4().int % 10_000_000),
            "callback_query": {
                "id": str(uuid.uuid4()),
                "from": user,
                "data": "c:trial",
                "message": {"message_id": message_id, "chat": {"id": TG_ID, "type": "private"}},
            },
        }
    )
    log("G", "repro:trial", "webhook_response", {"http": code2, "body": body2, "ms": ms2})

    time.sleep(40)
    log("E", "repro:after_trial", "db_state", fetch_sub_state())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
