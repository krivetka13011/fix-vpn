import json
import os
import sys
import uuid

import requests
import urllib3

urllib3.disable_warnings()

INBOUND_IDS = [19, 20, 21, 24]


def load_env():
    path = os.environ.get("PROJECT_CONFIG", "project_config.env")
    if not os.path.isfile(path):
        return
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


def sb_headers():
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


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
    load_env()
    required = ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "XUI_BASE_URL", "XUI_API_TOKEN")
    for name in required:
        if not os.environ.get(name):
            print(f"missing {name}", file=sys.stderr)
            sys.exit(1)

    sb_base = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1/"
    rows = requests.get(
        sb_base
        + "subscriptions?select=user_id,client_email,xray_sub_id,xray_uuid,subscription_url,users(telegram_id)&client_email=not.is.null",
        headers=sb_headers(),
        timeout=30,
    ).json()

    session, base = panel_session()
    sub_base = os.environ.get("SUBSCRIPTION_BASE_URL", "https://fixvp.xyz:2096").rstrip("/")
    sub_path = os.environ.get("SUBSCRIPTION_PATH", "/sub").rstrip("/")
    synced = 0

    for row in rows:
        email = str(row.get("client_email") or "").strip()
        if not email:
            continue
        user = row.get("users") or {}
        tg_id = int(user.get("telegram_id") or 0)
        sub_id = str(row.get("xray_sub_id") or "").strip() or ("sub" + uuid.uuid4().hex[:12])
        client_uuid = str(row.get("xray_uuid") or "").strip() or str(uuid.uuid4())
        existing = panel_has_email(session, base, email)
        if not existing:
            add_panel_client(session, base, email, sub_id, client_uuid, tg_id)
            existing = panel_has_email(session, base, email) or {"subId": sub_id, "uuid": client_uuid}
            synced += 1
        sub_url = f"{sub_base}{sub_path}/{existing['subId']}"
        patch = {
            "xray_sub_id": existing["subId"],
            "xray_uuid": existing["uuid"],
            "subscription_url": sub_url,
        }
        requests.patch(
            sb_base + f"subscriptions?user_id=eq.{row['user_id']}",
            headers={**sb_headers(), "Prefer": "return=minimal"},
            json=patch,
            timeout=30,
        )

    print(f"synced {synced} panel clients, checked {len(rows)} subscriptions")


if __name__ == "__main__":
    main()
