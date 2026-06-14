#!/usr/bin/env python3
"""Attach app.fixvp.xyz custom domain to fix-vpn Worker (DNS auto if zone is on Cloudflare)."""
from __future__ import annotations

import json
import os
import sys

import requests

ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "abd3a9f30b070ba7b27946ecb6b82945")
HOSTNAME = os.environ.get("PUBLIC_HOSTNAME", "app.fixvp.xyz")
ZONE_NAME = os.environ.get("PUBLIC_ZONE_NAME", "fixvp.xyz")


def cf_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def main() -> int:
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    zone_id = os.environ.get("CLOUDFLARE_FIXVP_ZONE_ID", "").strip()
    if not token:
        print("skip: CLOUDFLARE_API_TOKEN missing")
        return 0

    if not zone_id:
        response = requests.get(
            f"https://api.cloudflare.com/client/v4/zones?name={ZONE_NAME}",
            headers=cf_headers(token),
            timeout=30,
        )
        payload = response.json()
        zones = payload.get("result") or []
        if not zones:
            print(
                f"skip: zone {ZONE_NAME} not in Cloudflare account — "
                "add fixvp.xyz to Cloudflare, then re-run deploy"
            )
            return 0
        zone_id = zones[0]["id"]
        print("found zone", ZONE_NAME, zone_id)

    # List existing custom domains on the worker script
    list_url = (
        f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}"
        f"/workers/scripts/fix-vpn/domains"
    )
    existing = requests.get(list_url, headers=cf_headers(token), timeout=30).json()
    for row in existing.get("result") or []:
        if row.get("hostname") == HOSTNAME:
            print("already attached:", HOSTNAME)
            return 0

    attach_url = (
        f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}"
        f"/workers/domains"
    )
    body = {"hostname": HOSTNAME, "zone_id": zone_id, "service": "fix-vpn", "environment": "production"}
    response = requests.post(attach_url, headers=cf_headers(token), json=body, timeout=30)
    payload = response.json()
    if not payload.get("success"):
        print("attach failed:", json.dumps(payload, ensure_ascii=False)[:500], file=sys.stderr)
        return 1

    print("attached custom domain:", HOSTNAME)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
