#!/usr/bin/env python3
"""Attach sub.fixvp.xyz as Worker custom domain for Happ subscription import."""
from __future__ import annotations

import json
import os
import sys
import time

import requests

ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "abd3a9f30b070ba7b27946ecb6b82945")
ZONE_NAME = os.environ.get("PUBLIC_ZONE_NAME", "fixvp.xyz")
SUB_HOST = os.environ.get("SUB_HOSTNAME", "sub.fixvp.xyz")
WORKER_NAME = os.environ.get("WORKER_NAME", "fix-vpn")
PROBE_SUB_ID = os.environ.get("PROBE_SUB_ID", "njo34e9bouf9uy0o")


def load_env(path: str = "project_config.env") -> None:
    if not os.path.isfile(path):
        return
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.split("#", 1)[0].strip()
            if value and key not in os.environ:
                os.environ[key] = value


def cf_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def cf_api(token: str, method: str, path: str, **kwargs) -> dict:
    response = requests.request(
        method,
        f"https://api.cloudflare.com/client/v4{path}",
        headers=cf_headers(token),
        timeout=60,
        **kwargs,
    )
    try:
        payload = response.json()
    except Exception:
        payload = {"success": False, "errors": [{"message": response.text[:400]}]}
    if not payload.get("success"):
        print(
            f"CF {method} {path} failed:",
            json.dumps(payload, ensure_ascii=False)[:1200],
            file=sys.stderr,
        )
    return payload


def resolve_zone_id(token: str) -> str | None:
    zone_id = os.environ.get("CLOUDFLARE_FIXVP_ZONE_ID", "").strip()
    if zone_id:
        print("using zone id from env:", zone_id)
        return zone_id
    payload = cf_api(token, "GET", f"/zones?name={ZONE_NAME}")
    zones = payload.get("result") or []
    return zones[0]["id"] if zones else None


def worker_domain_attached(token: str, hostname: str) -> bool:
    payload = cf_api(
        token,
        "GET",
        f"/accounts/{ACCOUNT_ID}/workers/scripts/{WORKER_NAME}/domains",
    )
    for row in payload.get("result") or []:
        if row.get("hostname") == hostname:
            return True
    return False


def attach_worker_domain(token: str, zone_id: str) -> bool:
    if worker_domain_attached(token, SUB_HOST):
        print("already attached:", SUB_HOST)
        return True

    payload = cf_api(
        token,
        "POST",
        f"/accounts/{ACCOUNT_ID}/workers/domains",
        json={
            "hostname": SUB_HOST,
            "zone_id": zone_id,
            "service": WORKER_NAME,
            "environment": "production",
        },
    )
    if payload.get("success"):
        print("attached custom domain:", SUB_HOST)
        return True
    return False


def probe_subscription(sub_id: str = PROBE_SUB_ID) -> bool:
    url = f"https://{SUB_HOST}/sub/{sub_id}"
    for attempt in range(1, 9):
        try:
            response = requests.get(url, timeout=25, verify=True)
            body = response.text.strip()
            ok = (
                response.status_code == 200
                and len(body) > 200
                and not body.startswith("<")
            )
            print(
                f"probe attempt {attempt}:",
                url,
                response.status_code,
                "len",
                len(body),
                "ok",
                ok,
            )
            if ok:
                return True
        except Exception as exc:
            print(f"probe attempt {attempt} error:", exc)
        time.sleep(8)
    return False


def main() -> int:
    load_env()
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if not token:
        print("CLOUDFLARE_API_TOKEN missing", file=sys.stderr)
        return 1

    verify = cf_api(token, "GET", "/user/tokens/verify")
    if not verify.get("success"):
        return 1
    print("token ok")

    zone_id = resolve_zone_id(token)
    if not zone_id:
        print("zone not found — set CLOUDFLARE_FIXVP_ZONE_ID", file=sys.stderr)
        return 1

    if not attach_worker_domain(token, zone_id):
        return 1

    print("waiting for edge propagation...")
    if probe_subscription():
        print(f"SUCCESS: https://{SUB_HOST}/sub/ returns base64 over valid TLS")
        return 0

    print(
        "WARN: domain attached but probe still failing — DNS may need a few minutes",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
