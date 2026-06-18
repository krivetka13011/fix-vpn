#!/usr/bin/env python3
"""Wipe auto-created D1 users + panel clients; never touch manual panel entries."""
from __future__ import annotations

import json
import os
import sys

import requests
import urllib3

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from d1_utils import count_table, load_env, require_d1_env, wipe_customer_data, wipe_kv_customer_data

urllib3.disable_warnings()

MANUAL_PANEL_CLIENT_EMAILS = frozenset(
    {
        "max-mobile",
        "egor-mobile",
        "max-pc",
        "iv",
        "egor-pc",
        "Ba-mobile",
        "Ba-pc",
        "mom-mobile",
        "lv",
        "Sanya-mobile",
    }
)

INBOUND_IDS = [19, 20, 21, 24]


def panel_session() -> tuple[requests.Session, str]:
    base = os.environ["XUI_BASE_URL"].rstrip("/")
    token = os.environ["XUI_API_TOKEN"]
    session = requests.Session()
    session.verify = False
    session.headers.update({"Authorization": f"Bearer {token}"})
    return session, base


def scan_clients(session: requests.Session, base: str) -> list[dict]:
    found: list[dict] = []
    for inbound_id in INBOUND_IDS:
        response = session.get(f"{base}/panel/api/inbounds/get/{inbound_id}", timeout=30)
        payload = response.json()
        if not payload.get("success"):
            print("warn: inbound", inbound_id, "unreadable", payload.get("msg"), file=sys.stderr)
            continue
        settings = payload["obj"]["settings"]
        if isinstance(settings, str):
            settings = json.loads(settings)
        for client in settings.get("clients", []):
            found.append(
                {
                    "inbound": inbound_id,
                    "email": str(client.get("email", "")).strip(),
                    "tgId": client.get("tgId"),
                    "subId": str(client.get("subId") or ""),
                    "uuid": str(client.get("id") or ""),
                }
            )
    return found


def dedupe_by_uuid(clients: list[dict]) -> list[dict]:
    by_uuid: dict[str, dict] = {}
    for row in clients:
        uid = row.get("uuid") or ""
        if uid and uid not in by_uuid:
            by_uuid[uid] = row
    return list(by_uuid.values())


def delete_panel_client(session: requests.Session, base: str, email: str) -> bool:
    email = email.strip()
    if not email or email in MANUAL_PANEL_CLIENT_EMAILS:
        return False
    response = session.post(f"{base}/panel/api/clients/del/{email}", json={}, timeout=30)
    ok = response.ok or "success" in response.text.lower()
    print("panel del", email, "->", response.status_code, "ok" if ok else response.text[:120])
    return ok


def main() -> int:
    db_only = os.environ.get("DB_ONLY", "").strip().lower() in ("1", "true", "yes") or "--db-only" in sys.argv
    if db_only:
        os.environ["DB_ONLY"] = "1"

    require_d1_env()

    if db_only:
        print("=== DB ONLY (panel skipped) ===")
        print("BEFORE d1 users:", count_table("users"))
        print("BEFORE d1 subscriptions:", count_table("subscriptions"))
        wipe_customer_data()
        wipe_kv_customer_data()
        print("\n=== AFTER ===")
        print("d1 users:", count_table("users"))
        print("d1 subscriptions:", count_table("subscriptions"))
        print("d1 partners:", count_table("partners"))
        return 0

    session, base = panel_session()

    print("=== BEFORE ===")
    clients = dedupe_by_uuid(scan_clients(session, base))
    print("panel clients:", len(clients))
    for row in sorted(clients, key=lambda r: r["email"].lower()):
        tag = "KEEP" if row["email"] in MANUAL_PANEL_CLIENT_EMAILS else "DEL"
        print(f"  [{tag}] {row['email']} sub={row['subId']} uuid={row['uuid'][:8]}…")
    print("d1 users:", count_table("users"))

    to_delete = [row for row in clients if row["email"] not in MANUAL_PANEL_CLIENT_EMAILS]
    print(f"\n=== DELETE {len(to_delete)} auto panel clients ===")
    deleted = 0
    for row in to_delete:
        if delete_panel_client(session, base, row["email"]):
            deleted += 1

    print("\n=== WIPE D1 + KV (customers only; partners kept) ===")
    wipe_customer_data()
    wipe_kv_customer_data()

    print("\n=== AFTER ===")
    clients_after = dedupe_by_uuid(scan_clients(session, base))
    print("panel clients:", len(clients_after))
    for row in sorted(clients_after, key=lambda r: r["email"].lower()):
        print(f"  {row['email']} sub={row['subId']}")
    print("d1 users:", count_table("users"))
    print("d1 partners:", count_table("partners"))
    print(f"\nDone. Removed {deleted} panel clients.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
