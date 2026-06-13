"""Create panel clients for DB users missing xray_sub_id (runs outside Cloudflare Worker)."""
import json
import os
import random
import string
import sys
import uuid

import requests
import urllib3

urllib3.disable_warnings()

INBOUND_IDS = [19, 20, 21, 24]


def load_env(path="project_config.env"):
    if not os.path.isfile(path):
        return
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


def sb_headers(prefer="return=minimal"):
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
        response = session.get(f"{base}/panel/api/inbounds/get/{inbound_id}", timeout=30)
        payload = response.json()
        if not payload.get("success"):
            continue
        settings = payload["obj"]["settings"]
        if isinstance(settings, str):
            settings = json.loads(settings)
        for client in settings.get("clients", []):
            found.append(
                {
                    "inbound": inbound_id,
                    "email": str(client.get("email", "")),
                    "tgId": client.get("tgId"),
                    "subId": str(client.get("subId") or ""),
                    "uuid": str(client.get("id") or ""),
                }
            )
    return found


def find_panel_client(clients, telegram_id, username):
    tg = str(telegram_id)
    for row in clients:
        if str(row.get("tgId") or "") == tg:
            return row
        if row.get("email") == tg:
            return row
    if username:
        for row in clients:
            if row.get("email") == username:
                return row
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
    for name in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "XUI_BASE_URL", "XUI_API_TOKEN"):
        if not os.environ.get(name):
            raise RuntimeError(f"missing {name}")

    sb = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1/"
    worker = os.environ.get("WEBAPP_URL", "https://fix-vpn.krivetkagames.workers.dev").rstrip("/")

    rows = requests.get(
        sb
        + "subscriptions?select=user_id,xray_sub_id,xray_uuid,users!inner(telegram_id,username)",
        headers={**sb_headers("return=representation"), "Prefer": "return=representation"},
        timeout=30,
    ).json()

    if not rows:
        print("no users")
        return

    session, base = panel_session()
    clients = scan_clients(session, base)
    provisioned = 0

    def panel_live(row):
        sub_id = str(row.get("subId") or "").strip()
        if not sub_id:
            return False
        return len(sub_links(session, base, sub_id)) > 0

    def sub_links(session, base, sub_id):
        response = session.get(f"{base}/panel/api/clients/subLinks/{sub_id}", timeout=30)
        if not response.ok:
            return []
        payload = response.json()
        links = payload.get("obj") or []
        return links if isinstance(links, list) else []

    for row in rows:
        user = row.get("users") or {}
        tg_id = int(user.get("telegram_id") or 0)
        if not tg_id:
            continue
        username = user.get("username")
        user_id = row["user_id"]

        panel = find_panel_client(clients, tg_id, username)
        if panel and not panel_live(panel):
            print("stale panel row", tg_id, panel["subId"])
            panel = None

        db_sub = str(row.get("xray_sub_id") or "").strip()
        if not panel and db_sub:
            for candidate in clients:
                if candidate.get("email") in {"lv"}:
                    continue
                if candidate.get("subId") == db_sub and panel_live(candidate):
                    panel = candidate
                    break

        if not panel:
            sub_id = random_sub_id()
            client_uuid = str(uuid.uuid4())
            email = str(tg_id)
            add_panel_client(session, base, email, sub_id, client_uuid, tg_id)
            panel = {"email": email, "subId": sub_id, "uuid": client_uuid}
            clients = scan_clients(session, base)
            print("created", tg_id, sub_id)
        else:
            print("found", tg_id, panel["subId"])

        sub_id = panel["subId"].strip()
        client_uuid = panel["uuid"].strip()
        if not sub_id or not client_uuid:
            print("skip incomplete panel row", tg_id)
            continue

        patch = {
            "client_email": str(tg_id),
            "xray_sub_id": sub_id,
            "xray_uuid": client_uuid,
            "subscription_url": f"{worker}/api/sub/{sub_id}",
        }
        links = sub_links(session, base, sub_id)
        if links:
            patch["subscription_payload_cache"] = "\n".join(
                str(line).strip() for line in links if str(line).strip()
            )
        elif str(row.get("xray_sub_id") or "") != sub_id:
            patch["subscription_payload_cache"] = None
        requests.patch(
            sb + f"subscriptions?user_id=eq.{user_id}",
            headers=sb_headers(),
            json=patch,
            timeout=30,
        )
        provisioned += 1

    print(f"provisioned {provisioned}/{len(rows)}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("FAIL:", error, file=sys.stderr)
        sys.exit(1)
