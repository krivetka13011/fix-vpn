"""Verify Happ connect chain: 3 successful rounds (redirect + panel sub + crypto)."""
import json
import os
import re
import sys

import requests
import urllib3

urllib3.disable_warnings()

TG_ID = 1159166497
ROUNDS = 3


def load_env(path="project_config.env"):
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ[key.strip()] = value.strip()


def subscription_ok(body: str) -> bool:
    text = body.strip()
    if len(text) < 200:
        return False
    if text.startswith("#hide-settings"):
        return False
    if "error code:" in text or text.startswith("<!DOCTYPE"):
        return False
    return "dmxlc3M6Ly" in text or "vless://" in text


def extract_crypt_link(html: str) -> str:
    match = re.search(r'happ://crypt[45]/[^"\'<>\s]+', html)
    if not match:
        raise RuntimeError("crypt link missing in redirect HTML")
    return match.group(0)


def main():
    load_env()
    worker = os.environ["WEBAPP_URL"].rstrip("/")
    client_base = (
        os.environ.get("SUBSCRIPTION_CLIENT_BASE_URL")
        or os.environ.get("SUBSCRIPTION_BASE_URL", "https://fixvp.xyz:2096")
    ).rstrip("/")
    sub_path = os.environ.get("SUBSCRIPTION_PATH", "/sub").rstrip("/")

    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    sb = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1/"
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    user = requests.get(
        f"{sb}users?telegram_id=eq.{TG_ID}&select=id&limit=1",
        headers=headers,
        timeout=30,
    ).json()[0]
    sub = requests.get(
        f"{sb}subscriptions?user_id=eq.{user['id']}&select=status,xray_sub_id&limit=1",
        headers=headers,
        timeout=30,
    ).json()[0]
    if sub.get("status") != "active":
        print("FAIL: subscription not active", sub)
        sys.exit(1)

    sub_id = sub["xray_sub_id"]
    panel_url = f"{client_base}{sub_path}/{sub_id}"
    worker_url = f"{worker}/api/sub/{sub_id}"

    print("sub_id", sub_id)
    print("panel_url", panel_url)
    print("worker_url", worker_url)

    for round_no in range(1, ROUNDS + 1):
        print(f"\n=== Round {round_no}/{ROUNDS} ===")

        redirect = requests.get(
            f"{worker}/api/redirect/happ?sid={sub_id}",
            timeout=30,
        )
        if redirect.status_code != 200:
            raise RuntimeError(f"redirect HTTP {redirect.status_code}")
        crypt = extract_crypt_link(redirect.text)
        if not crypt.startswith("happ://crypt"):
            raise RuntimeError(f"bad crypt link: {crypt[:40]}")
        print("redirect OK", crypt[:48] + "...")

        crypto = requests.post(
            "https://crypto.happ.su/api-v2.php",
            json={"url": panel_url},
            timeout=30,
        )
        crypto_data = crypto.json()
        if not crypto_data.get("encrypted_link", "").startswith("happ://crypt"):
            raise RuntimeError(f"happ crypto failed: {json.dumps(crypto_data, ensure_ascii=False)}")
        print("happ crypto OK")

        panel = requests.get(panel_url, verify=False, timeout=30)
        if not subscription_ok(panel.text):
            raise RuntimeError(
                f"panel sub bad: status={panel.status_code} preview={panel.text[:120]!r}"
            )
        print("panel fetch OK", panel.status_code, len(panel.text), "bytes")

        worker_sub = requests.get(worker_url, timeout=30)
        if not subscription_ok(worker_sub.text):
            raise RuntimeError(
                f"worker sub bad: status={worker_sub.status_code} preview={worker_sub.text[:120]!r}"
            )
        print("worker fetch OK", worker_sub.status_code, len(worker_sub.text), "bytes")

    print(f"\nALL {ROUNDS} ROUNDS PASSED")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("FAIL:", error, file=sys.stderr)
        sys.exit(1)
