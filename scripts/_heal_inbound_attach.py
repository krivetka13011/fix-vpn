#!/usr/bin/env python3
import json
import os
import time

import requests
import urllib3

urllib3.disable_warnings()

TG = 1159166497
EMAIL = "@Krivetka1301-1"
SUB_ID = "e2e4c1fc7479092"
INBOUND_IDS = [19, 20, 21, 24]


def load_env():
    with open("project_config.env", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ[key.strip()] = value.strip()


def session():
    base = os.environ["XUI_BASE_URL"].rstrip("/")
    token = os.environ["XUI_API_TOKEN"]
    s = requests.Session()
    s.verify = False
    s.headers["Authorization"] = f"Bearer {token}"
    return s, base


def count_inbound(s, base):
    count = 0
    for inbound_id in INBOUND_IDS:
        payload = s.get(f"{base}/panel/api/inbounds/get/{inbound_id}", timeout=30).json()
        settings = payload["obj"]["settings"]
        if isinstance(settings, str):
            settings = json.loads(settings)
        for client in settings.get("clients", []):
            if int(client.get("tgId") or 0) == TG:
                count += 1
                print(
                    "inbound",
                    inbound_id,
                    client.get("email"),
                    client.get("id"),
                    client.get("enable"),
                )
    return count


def main():
    load_env()
    s, base = session()
    encoded = requests.utils.quote(EMAIL, safe="")
    row = s.get(f"{base}/panel/api/clients/get/{encoded}", timeout=30).json()
    client = row.get("obj", {}).get("client")
    if not client:
        print("global client missing")
        return 1
    print("before inbound", count_inbound(s, base))
    body_client = {
        "id": client.get("uuid") or client.get("id"),
        "email": EMAIL,
        "subId": client.get("subId") or SUB_ID,
        "limitIp": 1,
        "expiryTime": client.get("expiryTime") or int(time.time() * 1000) + 86400000 * 30,
        "enable": True,
        "tgId": TG,
        "totalGB": 0,
        "flow": "",
    }
    add = s.post(
        f"{base}/panel/api/clients/add",
        json={"inboundIds": INBOUND_IDS, "client": body_client},
        timeout=30,
    )
    print("add", add.status_code, add.text[:300])
    if add.status_code != 200 or not add.json().get("success", True):
        upd = s.post(
            f"{base}/panel/api/clients/update/{encoded}",
            json={"email": EMAIL, "inboundIds": INBOUND_IDS, "client": {**client, "enable": True, "tgId": TG}},
            timeout=30,
        )
        print("update", upd.status_code, upd.text[:300])
    print("after inbound", count_inbound(s, base))
    sub = requests.get(f"https://sub.fixvp.xyz/{SUB_ID}", timeout=90)
    print("sub", sub.status_code, len(sub.text))
    return 0 if sub.status_code == 200 else 1


if __name__ == "__main__":
    raise SystemExit(main())
