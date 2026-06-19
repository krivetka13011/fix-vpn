#!/usr/bin/env python3
import base64
import json
import os

import requests
import urllib3

urllib3.disable_warnings()

SUB_ID = "e2e4c1fc7479092"
TG = 1159166497


def load_env():
    with open("project_config.env", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ[key.strip()] = value.strip()


def delete_panel():
    base = os.environ["XUI_BASE_URL"].rstrip("/")
    token = os.environ["XUI_API_TOKEN"]
    inbound_ids = [int(x) for x in os.environ["XUI_INBOUND_IDS"].split(",")]
    session = requests.Session()
    session.verify = False
    session.headers["Authorization"] = f"Bearer {token}"
    emails = {str(TG), "@Krivetka1301-1"}
    for inbound_id in inbound_ids:
        payload = session.get(f"{base}/panel/api/inbounds/get/{inbound_id}", timeout=30).json()
        settings = payload["obj"]["settings"]
        if isinstance(settings, str):
            settings = json.loads(settings)
        filtered = [
            c
            for c in settings.get("clients", [])
            if int(c.get("tgId") or 0) != TG and str(c.get("email")) not in emails
        ]
        if len(filtered) == len(settings.get("clients", [])):
            continue
        body = {**payload["obj"], "settings": json.dumps({**settings, "clients": filtered})}
        for key in list(body):
            if body[key] is None:
                del body[key]
        session.post(f"{base}/panel/api/inbounds/update/{inbound_id}", json=body, timeout=30)
    for email in emails:
        encoded = requests.utils.quote(email, safe="")
        session.post(f"{base}/panel/api/clients/del/{encoded}", json={}, timeout=15)


def main():
    load_env()
    delete_panel()
    print("panel deleted")
    r = requests.get(f"https://sub.fixvp.xyz/{SUB_ID}", timeout=90)
    print("status", r.status_code)
    print("content-type", r.headers.get("content-type"))
    print("retry-after", r.headers.get("retry-after"))
    print("body_len", len(r.text))
    print("body_head", repr(r.text[:200]))
    if r.text.startswith("I2") or r.text.startswith("dmx"):
        try:
            decoded = base64.b64decode(r.text).decode("utf-8", "replace")
            print("decoded_head", decoded[:300])
        except Exception as exc:
            print("decode_error", exc)


if __name__ == "__main__":
    main()
