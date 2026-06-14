#!/usr/bin/env python3
import json
import os
import sys

import requests
import urllib3

urllib3.disable_warnings()

INBOUND_IDS = [19, 20, 21, 24]


def load_env(path="project_config.env"):
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ[key.strip()] = value.strip()


def main():
    load_env()
    email = sys.argv[1] if len(sys.argv) > 1 else "1159166497"
    base = os.environ["XUI_BASE_URL"].rstrip("/")
    token = os.environ["XUI_API_TOKEN"]
    session = requests.Session()
    session.verify = False
    session.headers["Authorization"] = f"Bearer {token}"

    for inbound_id in INBOUND_IDS:
        inbound = session.get(
            f"{base}/panel/api/inbounds/get/{inbound_id}", timeout=30
        ).json()["obj"]
        settings = inbound["settings"]
        if isinstance(settings, str):
            settings = json.loads(settings)
        full = next(
            (client for client in settings["clients"] if client.get("email") == email),
            None,
        )
        if not full:
            print("inbound", inbound_id, "client missing")
            continue
        print("before", inbound_id, "enable", full.get("enable"), "id", full.get("id"))
        full["enable"] = True
        payload = {"clients": [full]}
        response = session.post(
            f"{base}/panel/api/inbounds/updateClient/{full['id']}",
            data={"id": str(inbound_id), "settings": json.dumps(payload)},
            timeout=30,
        )
        print("updateClient", inbound_id, response.status_code, response.text[:160])

    row = session.get(f"{base}/panel/api/clients/get/{email}", timeout=30).json()
    client = row.get("obj", {}).get("client", {})
    print("global enable", client.get("enable"))


if __name__ == "__main__":
    raise SystemExit(main())
