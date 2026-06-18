import json
import os
import sys
import uuid

import requests
import urllib3

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from d1_utils import (
    fetch_subscriptions,
    kv_set_subcache,
    panel_sync_disabled,
    patch_subscription,
    require_d1_env,
)

urllib3.disable_warnings()

INBOUND_IDS = [19, 20, 21, 24]


def panel_session():
    base = os.environ["XUI_BASE_URL"].rstrip("/")
    token = os.environ["XUI_API_TOKEN"]
    session = requests.Session()
    session.verify = False
    session.headers.update(
        {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
    )
    return session, base


def scan_panel_index(session, base) -> dict[str, dict]:
    """Один проход по inbound — индекс email → {subId, uuid}."""
    index: dict[str, dict] = {}
    for inbound_id in INBOUND_IDS:
        response = session.get(f"{base}/panel/api/inbounds/get/{inbound_id}", timeout=30)
        payload = response.json()
        if not payload.get("success"):
            continue
        settings = payload["obj"]["settings"]
        if isinstance(settings, str):
            settings = json.loads(settings)
        for client in settings.get("clients", []):
            email = str(client.get("email") or "").strip()
            if not email or email in index:
                continue
            index[email] = {
                "subId": str(client.get("subId") or ""),
                "uuid": str(client.get("id") or ""),
            }
    return index


def add_panel_client(session, base, email, sub_id, client_uuid, tg_id):
    client = {
        "id": client_uuid,
        "email": email,
        "subId": sub_id,
        "limitIp": int(os.environ.get("XUI_CLIENT_LIMIT_IP", "1")),
        "expiryTime": 0,
        "enable": True,
        "tgId": tg_id,
        "totalGB": 0,
        "flow": "",
    }
    response = session.post(
        f"{base}/panel/api/clients/add",
        json={"inboundIds": INBOUND_IDS, "client": client},
        timeout=30,
    )
    data = response.json()
    if data.get("success"):
        return True
    if "already in use" in str(data.get("msg", "")).lower():
        return True
    raise RuntimeError(data)


def main():
    if panel_sync_disabled():
        print("PANEL_SYNC_DISABLED — skip panel API")
        return

    require_d1_env()
    rows = fetch_subscriptions()

    session, base = panel_session()
    panel_index = scan_panel_index(session, base)
    webapp = os.environ.get("WEBAPP_URL", "https://app.fixvp.xyz").rstrip("/")
    synced = 0

    for row in rows:
        user = row.get("users") or {}
        tg_id = int(user.get("telegram_id") or 0)
        if not tg_id:
            continue
        email = str(row.get("client_email") or tg_id).strip()
        sub_id = str(row.get("xray_sub_id") or "").strip()
        client_uuid = str(row.get("xray_uuid") or "").strip()

        existing = panel_index.get(email) or panel_index.get(str(tg_id))
        if existing and sub_id:
            continue

        if not sub_id:
            sub_id = "sub" + uuid.uuid4().hex[:12]
        if not client_uuid:
            client_uuid = str(uuid.uuid4())

        if not existing:
            add_panel_client(session, base, email, sub_id, client_uuid, tg_id)
            existing = {"subId": sub_id, "uuid": client_uuid}
            panel_index[email] = existing
            synced += 1

        patch_subscription(
            str(row["user_id"]),
            {
                "client_email": email,
                "xray_sub_id": existing["subId"],
                "xray_uuid": existing["uuid"],
                "subscription_url": f"{webapp}/api/sub/{existing['subId']}",
            },
        )

    print(f"synced {synced} new panel clients, skipped {len(rows) - synced} already bound")


if __name__ == "__main__":
    main()
