"""Heal tester: bind panel client lv -> telegram id, sync DB, clear bindings."""
import json
import os
import sys

import requests
import urllib3

urllib3.disable_warnings()

TG_ID = 1159166497
PANEL_SUB_ID = "0n5regyvk6mang59"
PANEL_UUID = "e36eb169-9b34-42cc-bc12-01758349b80c"
PANEL_OLD_EMAIL = "lv"


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


def main():
    load_env()
    sb = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1/"
    host = os.environ.get("VPN_SERVER_HOST", "fixvp.xyz").strip()
    panel_url = f"https://{host}:2096/sub/{PANEL_SUB_ID}"

    user = requests.get(
        f"{sb}users?telegram_id=eq.{TG_ID}&select=id,username&limit=1",
        headers=sb_headers(),
        timeout=30,
    ).json()[0]
    user_id = user["id"]
    print("user", user_id, user.get("username"))

    for table in ("bot_sessions", "vpn_device_bindings", "xui_client_inbounds"):
        r = requests.delete(
            f"{sb}{table}",
            headers=sb_headers("return=minimal"),
            params={"user_id": f"eq.{user_id}"},
            timeout=30,
        )
        print("clear", table, r.status_code)

    base = os.environ["XUI_BASE_URL"].rstrip("/")
    token = os.environ["XUI_API_TOKEN"]
    inbound_ids = [int(x) for x in os.environ["XUI_INBOUND_IDS"].split(",")]
    session = requests.Session()
    session.verify = False
    session.headers.update(
        {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
    )

    client = {
        "id": PANEL_UUID,
        "email": str(TG_ID),
        "subId": PANEL_SUB_ID,
        "limitIp": int(os.environ.get("XUI_CLIENT_LIMIT_IP", "1")),
        "expiryTime": 0,
        "enable": True,
        "tgId": TG_ID,
        "totalGB": 0,
        "flow": "",
    }
    response = session.post(
        f"{base}/panel/api/clients/update/{PANEL_OLD_EMAIL}",
        json={"email": PANEL_OLD_EMAIL, "inboundIds": inbound_ids, "client": client},
        timeout=30,
    )
    print("panel rebind", response.status_code, response.text[:200])

    sub_patch = {
        "status": "active",
        "plan_label": "Пробный · 3 дн.",
        "billing_months": 0,
        "is_trial": True,
        "client_email": str(TG_ID),
        "xray_sub_id": PANEL_SUB_ID,
        "xray_uuid": PANEL_UUID,
        "subscription_url": panel_url,
        "extra_devices": 0,
    }
    r = requests.patch(
        f"{sb}subscriptions?user_id=eq.{user_id}",
        headers=sb_headers("return=representation"),
        json=sub_patch,
        timeout=30,
    )
    print("db sync", r.status_code, json.dumps(r.json(), ensure_ascii=False)[:300])

    for url in (panel_url, f"https://31.76.2.248:2096/sub/{PANEL_SUB_ID}"):
        check = requests.get(url, verify=False, timeout=20)
        print("check", url, check.status_code, len(check.text))

    worker = os.environ["WEBAPP_URL"].rstrip("/")
    red = requests.get(f"{worker}/api/redirect/happ?sid={PANEL_SUB_ID}", timeout=30)
    print("redirect", red.status_code, "crypt" in red.text)

    print("OK healed", panel_url)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("FAIL:", error, file=sys.stderr)
        sys.exit(1)
