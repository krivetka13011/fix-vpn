#!/usr/bin/env python3
"""Wipe auto-created Supabase users + panel clients; never touch manual panel entries."""
from __future__ import annotations

import json
import os
import sys

import requests
import urllib3

urllib3.disable_warnings()

# Manual panel clients — NEVER delete, edit, or recreate (user-added).
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
    }
)

INBOUND_IDS = [19, 20, 21, 24]


def load_env(path: str = "project_config.env") -> None:
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ[key.strip()] = value.strip().strip('"').strip("'")


def sb_headers(prefer: str = "return=representation") -> dict[str, str]:
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": prefer,
    }


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


def wipe_supabase(sb: str) -> None:
    deletes: list[tuple[str, dict]] = [
        ("bot_sessions", {"telegram_id": "neq.0"}),
        ("vpn_device_bindings", {"id": "neq.00000000-0000-0000-0000-000000000000"}),
        ("xui_client_inbounds", {"id": "neq.00000000-0000-0000-0000-000000000000"}),
        ("addon_purchases", {"id": "neq.00000000-0000-0000-0000-000000000000"}),
        ("transactions", {"id": "neq.00000000-0000-0000-0000-000000000000"}),
        ("subscriptions", {"id": "neq.00000000-0000-0000-0000-000000000000"}),
        ("users", {"telegram_id": "neq.0"}),
    ]
    for table, params in deletes:
        response = requests.delete(
            f"{sb}{table}",
            headers=sb_headers("return=minimal"),
            params=params,
            timeout=60,
        )
        print("supabase", table, response.status_code)


def count_table(sb: str, table: str, params: dict | None = None) -> int:
    headers = {**sb_headers(), "Prefer": "count=exact"}
    response = requests.head(
        f"{sb}{table}",
        headers=headers,
        params=params or {"select": "id"},
        timeout=30,
    )
    content_range = response.headers.get("Content-Range", "")
    if "/" in content_range:
        return int(content_range.split("/")[-1])
    rows = requests.get(f"{sb}{table}?select=id&limit=1000", headers=sb_headers(), timeout=30).json()
    return len(rows) if isinstance(rows, list) else 0


def main() -> int:
    load_env()
    for name in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "XUI_BASE_URL", "XUI_API_TOKEN"):
        if not os.environ.get(name):
            print(f"missing {name} in project_config.env", file=sys.stderr)
            return 1

    sb = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1/"
    session, base = panel_session()

    print("=== BEFORE ===")
    clients = dedupe_by_uuid(scan_clients(session, base))
    print("panel clients:", len(clients))
    for row in sorted(clients, key=lambda r: r["email"].lower()):
        tag = "KEEP" if row["email"] in MANUAL_PANEL_CLIENT_EMAILS else "DEL"
        print(f"  [{tag}] {row['email']} sub={row['subId']} uuid={row['uuid'][:8]}…")
    print("supabase users:", count_table(sb, "users"))

    to_delete = [row for row in clients if row["email"] not in MANUAL_PANEL_CLIENT_EMAILS]
    print(f"\n=== DELETE {len(to_delete)} auto panel clients ===")
    deleted = 0
    for row in to_delete:
        if delete_panel_client(session, base, row["email"]):
            deleted += 1

    print("\n=== WIPE SUPABASE (customers only; partners kept) ===")
    wipe_supabase(sb)

    print("\n=== AFTER ===")
    clients_after = dedupe_by_uuid(scan_clients(session, base))
    print("panel clients:", len(clients_after))
    for row in sorted(clients_after, key=lambda r: r["email"].lower()):
        print(f"  {row['email']} sub={row['subId']}")
    print("supabase users:", count_table(sb, "users"))
    print("supabase partners:", count_table(sb, "partners"))
    print(f"\nDone. Removed {deleted} panel clients.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
