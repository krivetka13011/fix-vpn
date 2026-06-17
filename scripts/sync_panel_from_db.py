import json
import os
import sys
import uuid

import requests
import urllib3

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from d1_utils import fetch_subscriptions, kv_set_subcache, load_env, patch_subscription, require_d1_env
from panel_enable_utils import force_enable_panel_client

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


def panel_has_email(session, base, email):
    for inbound_id in INBOUND_IDS:
        response = session.get(f"{base}/panel/api/inbounds/get/{inbound_id}", timeout=30)
        payload = response.json()
        if not payload.get("success"):
            continue
        settings = payload["obj"]["settings"]
        if isinstance(settings, str):
            settings = json.loads(settings)
        for client in settings.get("clients", []):
            if str(client.get("email")) == email:
                return {
                    "subId": str(client.get("subId") or ""),
                    "uuid": str(client.get("id") or ""),
                }
    return None


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
    require_d1_env()
    rows = fetch_subscriptions("s.client_email IS NOT NULL")

    session, base = panel_session()
    sub_base = os.environ.get(
        "SUBSCRIPTION_CLIENT_BASE_URL",
        os.environ.get("SUBSCRIPTION_BASE_URL", "https://fixvp.xyz:2096"),
    ).rstrip("/")
    sub_path = os.environ.get("SUBSCRIPTION_PATH", "/sub").rstrip("/")
    webapp = os.environ.get("WEBAPP_URL", "https://app.fixvp.xyz").rstrip("/")
    synced = 0
    cached = 0
    enabled = 0

    for row in rows:
        email = str(row.get("client_email") or "").strip()
        if not email:
            continue
        user = row.get("users") or {}
        tg_id = int(user.get("telegram_id") or 0)
        if not tg_id:
            continue
        sub_id = str(row.get("xray_sub_id") or "").strip() or ("sub" + uuid.uuid4().hex[:12])
        client_uuid = str(row.get("xray_uuid") or "").strip() or str(uuid.uuid4())
        existing = panel_has_email(session, base, email)
        if not existing:
            add_panel_client(session, base, email, sub_id, client_uuid, tg_id)
            existing = panel_has_email(session, base, email) or {"subId": sub_id, "uuid": client_uuid}
            synced += 1

        if force_enable_panel_client(session, base, tg_id, email, row):
            enabled += 1

        protected_url = f"{webapp}/api/sub/{existing['subId']}"
        fetch_url = f"{sub_base}{sub_path}/{existing['subId']}"
        payload_cache = None
        try:
            response = requests.get(fetch_url, timeout=20, verify=False)
            if response.ok and len(response.text.strip()) > 100:
                payload_cache = response.text
                cached += 1
        except Exception as error:
            print(f"cache fetch failed for {existing['subId']}: {error}", file=sys.stderr)
        patch = {
            "xray_sub_id": existing["subId"],
            "xray_uuid": existing["uuid"],
            "subscription_url": protected_url,
        }
        patch_subscription(str(row["user_id"]), patch)
        if payload_cache:
            kv_set_subcache(str(row["user_id"]), payload_cache)

    print(
        f"synced {synced} panel clients, enabled {enabled}/{len(rows)}, "
        f"cached {cached} payloads, checked {len(rows)} subscriptions"
    )


if __name__ == "__main__":
    main()
