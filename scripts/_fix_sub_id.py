import json
import os
import requests
import urllib3

urllib3.disable_warnings()

TG_ID = 1159166497
INBOUND_IDS = [19, 20, 21, 24]

with open("project_config.env", encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ[k.strip()] = v.strip()

base = os.environ["XUI_BASE_URL"].rstrip("/")
token = os.environ["XUI_API_TOKEN"]
session = requests.Session()
session.verify = False
session.headers.update({"Authorization": f"Bearer {token}"})

email = str(TG_ID)
panel = None
for inbound_id in INBOUND_IDS:
    payload = session.get(f"{base}/panel/api/inbounds/get/{inbound_id}", timeout=30).json()
    if not payload.get("success"):
        continue
    settings = payload["obj"]["settings"]
    if isinstance(settings, str):
        settings = json.loads(settings)
    for client in settings.get("clients", []):
        if str(client.get("email")) == email:
            panel = {
                "subId": client.get("subId"),
                "id": client.get("id"),
                "enable": client.get("enable"),
            }
            break
    if panel:
        break

print("panel", panel)

key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
sb = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1/"
h = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json", "Prefer": "return=minimal"}
user = requests.get(f"{sb}users?telegram_id=eq.{TG_ID}&select=id&limit=1", headers=h).json()[0]
sub_base = os.environ["SUBSCRIPTION_BASE_URL"].rstrip("/")
sub_path = os.environ.get("SUBSCRIPTION_PATH", "/sub").rstrip("/")

if panel and panel.get("subId"):
    sub_url = f"{sub_base}{sub_path}/{panel['subId']}"
    requests.patch(
        f"{sb}subscriptions?user_id=eq.{user['id']}",
        headers=h,
        json={
            "client_email": email,
            "xray_sub_id": panel["subId"],
            "xray_uuid": panel["id"],
            "subscription_url": sub_url,
        },
        timeout=30,
    )
    r = requests.get(sub_url, verify=False, timeout=15)
    print("fixed url", sub_url)
    print("sub status", r.status_code, "bytes", len(r.text))
    print("preview", r.text[:300])
else:
    print("panel client missing for", email)
