"""Refresh subscription_payload_cache for all active subscriptions (runs outside Worker)."""
import base64
import json
import os
import re
import sys

import requests
import urllib3

urllib3.disable_warnings()

PLAIN_RE = re.compile(r"^(vless|vmess|trojan|ss|hysteria2|tuic)://", re.I)


def load_env(path="project_config.env"):
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ[key.strip()] = value.strip()


def sb_headers():
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }


def normalize_body(raw: str) -> str:
    text = raw.strip()
    if not text:
        return ""
    if PLAIN_RE.search(text):
        return "\n".join(
            line.strip()
            for line in text.splitlines()
            if line.strip() and PLAIN_RE.match(line.strip())
        )
    try:
        decoded = base64.b64decode(text.replace("\n", ""), validate=False).decode("utf-8")
        if PLAIN_RE.search(decoded):
            return "\n".join(
                line.strip()
                for line in decoded.splitlines()
                if line.strip() and PLAIN_RE.match(line.strip())
            )
    except Exception:
        pass
    return text


def fetch_payload(session: requests.Session, base: str, sub_id: str) -> str | None:
    token = os.environ.get("XUI_API_TOKEN", "")
    api_url = f"{base.rstrip('/')}/panel/api/clients/subLinks/{sub_id}"
    try:
        response = session.get(
            api_url,
            headers={"Authorization": f"Bearer {token}"},
            timeout=25,
        )
        if response.ok:
            payload = response.json()
            links = payload.get("obj") or []
            if isinstance(links, list) and links:
                body = "\n".join(str(line).strip() for line in links if str(line).strip())
                if PLAIN_RE.search(body):
                    return body
    except Exception as error:
        print("subLinks failed", sub_id, error, file=sys.stderr)

    sub_base = os.environ.get(
        "SUBSCRIPTION_CLIENT_BASE_URL",
        os.environ.get("SUBSCRIPTION_BASE_URL", "https://fixvp.xyz:2096"),
    ).rstrip("/")
    sub_path = os.environ.get("SUBSCRIPTION_PATH", "/sub").rstrip("/")
    sub_url = f"{sub_base}{sub_path}/{sub_id}"
    try:
        response = session.get(sub_url, timeout=25)
        if response.ok and len(response.text.strip()) > 100:
            body = normalize_body(response.text)
            if PLAIN_RE.search(body):
                return body
    except Exception as error:
        print("sub port failed", sub_id, error, file=sys.stderr)
    return None


def main():
    load_env()
    sb = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1/"
    rows = requests.get(
        sb
        + "subscriptions?select=user_id,xray_sub_id,status&xray_sub_id=not.is.null&status=eq.active",
        headers={**sb_headers(), "Prefer": "return=representation"},
        timeout=30,
    ).json()

    session = requests.Session()
    session.verify = False
    panel_base = os.environ.get("XUI_BASE_URL", "").rstrip("/")
    if not panel_base:
        raise RuntimeError("XUI_BASE_URL missing")

    updated = 0
    for row in rows:
        sub_id = str(row.get("xray_sub_id") or "").strip()
        if not sub_id:
            continue
        body = fetch_payload(session, panel_base, sub_id)
        if not body:
            print("skip", sub_id, "no payload")
            continue
        requests.patch(
            sb + f"subscriptions?user_id=eq.{row['user_id']}",
            headers=sb_headers(),
            json={"subscription_payload_cache": body},
            timeout=30,
        )
        updated += 1
        print("cached", sub_id, len(body), "bytes")

    print(f"done: {updated}/{len(rows)} caches refreshed")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("FAIL:", error, file=sys.stderr)
        sys.exit(1)
