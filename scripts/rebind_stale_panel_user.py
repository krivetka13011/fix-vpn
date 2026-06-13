"""Rebind tester to a fresh panel client when DB points at a deleted panel user."""
import json
import os
import random
import string
import sys
import uuid

import requests
import urllib3

urllib3.disable_warnings()

TG_ID = 1159166497
SKIP_EMAILS = {"lv"}  # developer clients — do not touch
INBOUND_IDS = [19, 20, 21, 24]


def load_env(path="project_config.env"):
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ[key.strip()] = value.strip()


def sb_headers(prefer="return=representation"):
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": prefer,
    }


def random_sub_id(length=16):
    alphabet = string.ascii_lowercase + string.digits
    return "".join(random.choice(alphabet) for _ in range(length))


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


def scan_clients(session, base):
    found = []
    for inbound_id in INBOUND_IDS:
        payload = session.get(f"{base}/panel/api/inbounds/get/{inbound_id}", timeout=30).json()
        if not payload.get("success"):
            continue
        settings = payload["obj"]["settings"]
        if isinstance(settings, str):
            settings = json.loads(settings)
        for client in settings.get("clients", []):
            found.append(
                {
                    "email": str(client.get("email", "")),
                    "tgId": client.get("tgId"),
                    "subId": str(client.get("subId") or ""),
                    "uuid": str(client.get("id") or ""),
                }
            )
    return found


def sub_links(session, base, sub_id):
    response = session.get(f"{base}/panel/api/clients/subLinks/{sub_id}", timeout=30)
    if not response.ok:
        return []
    payload = response.json()
    links = payload.get("obj") or []
    return links if isinstance(links, list) else []


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
        return
    if "already in use" in str(data.get("msg", "")).lower():
        return
    raise RuntimeError(data)


def main():
    load_env()
    sb = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1/"
    worker = os.environ["WEBAPP_URL"].rstrip("/")

    user = requests.get(
        f"{sb}users?telegram_id=eq.{TG_ID}&select=id,username&limit=1",
        headers=sb_headers(),
        timeout=30,
    ).json()[0]
    sub = requests.get(
        f"{sb}subscriptions?user_id=eq.{user['id']}&select=*&limit=1",
        headers=sb_headers(),
        timeout=30,
    ).json()[0]

    old_sub_id = str(sub.get("xray_sub_id") or "")
    print("old db sub_id", old_sub_id)

    session, base = panel_session()
    clients = scan_clients(session, base)

    live = None
    for row in clients:
        if row["email"] in SKIP_EMAILS:
            continue
        if str(row.get("tgId") or "") == str(TG_ID) or row["email"] == str(TG_ID):
            links = sub_links(session, base, row["subId"])
            if links:
                live = row
                break

    if not live:
        sub_id = random_sub_id()
        client_uuid = str(uuid.uuid4())
        email = str(TG_ID)
        print("creating fresh panel client", email, sub_id)
        add_panel_client(session, base, email, sub_id, client_uuid, TG_ID)
        live = {"email": email, "subId": sub_id, "uuid": client_uuid}
    else:
        print("found live panel client", live)

    links = sub_links(session, base, live["subId"])
    if not links:
        raise RuntimeError(f"panel subLinks empty for {live['subId']}")

    body = "\n".join(str(line).strip() for line in links if str(line).strip())
    patch = {
        "client_email": str(TG_ID),
        "xray_sub_id": live["subId"],
        "xray_uuid": live["uuid"],
        "subscription_url": f"{worker}/api/sub/{live['subId']}",
        "subscription_payload_cache": body,
    }
    response = requests.patch(
        f"{sb}subscriptions?user_id=eq.{user['id']}",
        headers=sb_headers(),
        json=patch,
        timeout=30,
    )
    print("db updated", response.status_code, json.dumps(response.json(), ensure_ascii=False)[:400])

    check = requests.get(f"{worker}/api/sub/{live['subId']}", timeout=30)
    print("worker sub", check.status_code, check.text.count("vless://"), "vless lines")
    print("OK new sub_id", live["subId"])


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("FAIL:", error, file=sys.stderr)
        sys.exit(1)
