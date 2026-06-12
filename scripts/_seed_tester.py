import json
import os
import sys

import requests
import urllib3

urllib3.disable_warnings()

TG_ID = 1159166497


def load_env():
    with open("project_config.env", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ[key.strip()] = value.strip()


def main():
    load_env()
    base = os.environ["XUI_BASE_URL"].rstrip("/")
    token = os.environ["XUI_API_TOKEN"]
    inbound_ids = [int(x) for x in os.environ["XUI_INBOUND_IDS"].split(",")]
    headers = {"Authorization": f"Bearer {token}"}

    client = None
    for inbound_id in inbound_ids:
        response = requests.get(
            f"{base}/panel/api/inbounds/get/{inbound_id}",
            headers=headers,
            verify=False,
            timeout=30,
        )
        payload = response.json()
        if not payload.get("success"):
            continue
        settings = payload["obj"]["settings"]
        if isinstance(settings, str):
            settings = json.loads(settings)
        for row in settings.get("clients", []):
            if str(row.get("email")) == str(TG_ID):
                client = row
                break
        if client:
            break

    if not client:
        print("panel client not found for", TG_ID, file=sys.stderr)
        sys.exit(1)

    sub_base = os.environ["SUBSCRIPTION_BASE_URL"].rstrip("/")
    sub_path = os.environ.get("SUBSCRIPTION_PATH", "/sub").rstrip("/")
    sub_url = f"{sub_base}{sub_path}/{client['subId']}"

    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    sb = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1/"
    sb_headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    user = requests.get(
        f"{sb}users?telegram_id=eq.{TG_ID}&select=id&limit=1",
        headers=sb_headers,
        timeout=30,
    ).json()[0]
    requests.patch(
        f"{sb}users?telegram_id=eq.{TG_ID}",
        headers=sb_headers,
        json={"has_used_trial": False, "is_tester": True},
        timeout=30,
    )
    response = requests.patch(
        f"{sb}subscriptions?user_id=eq.{user['id']}",
        headers=sb_headers,
        json={
            "status": "none",
            "plan_label": None,
            "billing_months": None,
            "starts_at": None,
            "ends_at": None,
            "is_trial": False,
            "client_email": str(TG_ID),
            "xray_sub_id": client["subId"],
            "xray_uuid": client["id"],
            "subscription_url": sub_url,
        },
        timeout=30,
    )
    if response.status_code >= 400:
        print(response.text, file=sys.stderr)
        sys.exit(1)
    print("seeded", TG_ID, client["subId"], sub_url)


if __name__ == "__main__":
    main()
