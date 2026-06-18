"""Refresh subscription payload cache in KV for active subs missing cache."""
import base64
import os
import re
import sys

import requests
import urllib3

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from d1_utils import (
    d1_query,
    kv_clear_subcache,
    kv_get,
    kv_set_subcache,
    panel_sync_disabled,
    require_d1_env,
    subcache_key,
)

urllib3.disable_warnings()

PLAIN_RE = re.compile(r"^(vless|vmess|trojan|ss|hysteria2|tuic)://", re.I)


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
    if panel_sync_disabled():
        print("PANEL_SYNC_DISABLED — skip panel API")
        return

    require_d1_env()
    force_all = os.environ.get("REFRESH_ALL_SUB_CACHES", "").strip() == "1"
    rows = d1_query(
        "SELECT user_id, xray_sub_id, status FROM subscriptions "
        "WHERE xray_sub_id IS NOT NULL AND status = 'active'"
    )

    session = requests.Session()
    session.verify = False
    panel_base = os.environ.get("XUI_BASE_URL", "").rstrip("/")
    if not panel_base:
        raise RuntimeError("XUI_BASE_URL missing")

    updated = 0
    skipped = 0
    for row in rows:
        sub_id = str(row.get("xray_sub_id") or "").strip()
        user_id = str(row.get("user_id") or "").strip()
        if not sub_id or not user_id:
            continue
        if not force_all:
            cached = kv_get(subcache_key(user_id))
            if cached and len(cached.strip()) > 80:
                skipped += 1
                continue
        body = fetch_payload(session, panel_base, sub_id)
        if not body:
            print("clear stale cache", sub_id)
            kv_clear_subcache(user_id)
            continue
        kv_set_subcache(user_id, body)
        updated += 1
        print("cached", sub_id, len(body), "bytes")

    print(f"done: {updated} refreshed, {skipped} skipped (cache ok), {len(rows)} active")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("FAIL:", error, file=sys.stderr)
        sys.exit(1)
