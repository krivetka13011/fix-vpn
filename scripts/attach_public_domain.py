#!/usr/bin/env python3
"""Ensure fixvp.xyz zone + app.fixvp.xyz Worker custom domain (Option A)."""
from __future__ import annotations

import json
import os
import sys
import time

import requests

ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "abd3a9f30b070ba7b27946ecb6b82945")
HOSTNAME = os.environ.get("PUBLIC_HOSTNAME", "app.fixvp.xyz")
ZONE_NAME = os.environ.get("PUBLIC_ZONE_NAME", "fixvp.xyz")
APEX_IP = os.environ.get("FIXVP_APEX_IP", "31.76.2.248")
WORKER_NAME = os.environ.get("WORKER_NAME", "fix-vpn")
SPACESHIP_API = "https://api.spaceship.com"


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
        payload = {"success": False, "errors": [{"message": response.text[:300]}]}
    if not payload.get("success"):
        print(f"CF {method} {path} failed:", json.dumps(payload, ensure_ascii=False)[:800], file=sys.stderr)
    return payload


def ensure_zone(token: str) -> str | None:
    zone_id = os.environ.get("CLOUDFLARE_FIXVP_ZONE_ID", "").strip()
    if zone_id:
        print("using zone id from env:", zone_id)
        return zone_id

    payload = cf_api(token, "GET", f"/zones?name={ZONE_NAME}")
    zones = payload.get("result") or []
    if zones:
        zone_id = zones[0]["id"]
        print("found zone", ZONE_NAME, zone_id, "status=", zones[0].get("status"))
        return zone_id

    print("creating zone", ZONE_NAME)
    payload = cf_api(
        token,
        "POST",
        "/zones",
        json={
            "name": ZONE_NAME,
            "account": {"id": ACCOUNT_ID},
            "jump_start": False,
            "type": "full",
        },
    )
    zones = payload.get("result") or []
    if not zones:
        return None
    zone_id = zones[0]["id"]
    print("created zone", zone_id, "status=", zones[0].get("status"))
    nameservers = zones[0].get("name_servers") or []
    if nameservers:
        print("cloudflare nameservers:", ", ".join(nameservers))
    return zone_id


def ensure_apex_a_record(token: str, zone_id: str) -> None:
    payload = cf_api(token, "GET", f"/zones/{zone_id}/dns_records?type=A&name={ZONE_NAME}")
    records = payload.get("result") or []
    for row in records:
        if row.get("content") == APEX_IP:
            print("apex A record already set:", APEX_IP)
            return

    payload = cf_api(
        token,
        "POST",
        f"/zones/{zone_id}/dns_records",
        json={
            "type": "A",
            "name": ZONE_NAME,
            "content": APEX_IP,
            "ttl": 300,
            "proxied": False,
        },
    )
    if payload.get("success"):
        print("created apex A record", ZONE_NAME, "->", APEX_IP)


def worker_domain_attached(token: str) -> bool:
    payload = cf_api(
        token,
        "GET",
        f"/accounts/{ACCOUNT_ID}/workers/scripts/{WORKER_NAME}/domains",
    )
    for row in payload.get("result") or []:
        if row.get("hostname") == HOSTNAME:
            return True
    return False


def attach_worker_domain(token: str, zone_id: str) -> bool:
    if worker_domain_attached(token):
        print("already attached:", HOSTNAME)
        return True

    payload = cf_api(
        token,
        "POST",
        f"/accounts/{ACCOUNT_ID}/workers/domains",
        json={
            "hostname": HOSTNAME,
            "zone_id": zone_id,
            "service": WORKER_NAME,
            "environment": "production",
        },
    )
    if payload.get("success"):
        print("attached custom domain:", HOSTNAME)
        return True
    return False


def app_dns_target(token: str, zone_id: str) -> str | None:
    payload = cf_api(token, "GET", f"/zones/{zone_id}/dns_records?name={HOSTNAME}")
    for row in payload.get("result") or []:
        content = row.get("content")
        if content:
            print("cloudflare dns for app:", row.get("type"), content, "proxied=", row.get("proxied"))
            return content
    return None


def spaceship_headers() -> dict[str, str] | None:
    key = os.environ.get("SPACESHIP_API_KEY", "").strip()
    secret = os.environ.get("SPACESHIP_API_SECRET", "").strip()
    if not key or not secret:
        return None
    return {
        "X-API-Key": key,
        "X-API-Secret": secret,
        "Content-Type": "application/json",
    }


def spaceship_get_records(headers: dict[str, str]) -> list[dict]:
    response = requests.get(
        f"{SPACESHIP_API}/v1/dns/records/{ZONE_NAME}",
        headers=headers,
        timeout=60,
    )
    payload = response.json()
    items = payload.get("items") or payload.get("result") or []
    if isinstance(items, dict):
        items = items.get("items") or []
    return items


def spaceship_upsert_app_cname(target: str) -> bool:
    headers = spaceship_headers()
    if not headers:
        print("spaceship: no API keys — skip external DNS update")
        return False

    target = target.rstrip(".")
    existing = spaceship_get_records(headers)
    items: list[dict] = []
    replaced = False
    for row in existing:
        if row.get("type") == "CNAME" and row.get("name") in ("app", "app.fixvp.xyz"):
            items.append({"type": "CNAME", "name": "app", "cname": target, "ttl": 300})
            replaced = True
        else:
            items.append(row)
    if not replaced:
        items.append({"type": "CNAME", "name": "app", "cname": target, "ttl": 300})

    response = requests.put(
        f"{SPACESHIP_API}/v1/dns/records/{ZONE_NAME}",
        headers=headers,
        json={"items": items},
        timeout=60,
    )
    if response.status_code >= 400:
        print("spaceship dns put failed:", response.status_code, response.text[:500], file=sys.stderr)
        return False
    print("spaceship: CNAME app ->", target)
    return True


def wait_dns(hostname: str, attempts: int = 12) -> bool:
    import socket

    for attempt in range(1, attempts + 1):
        try:
            socket.getaddrinfo(hostname, 443)
            print("dns ready:", hostname, f"(attempt {attempt})")
            return True
        except socket.gaierror:
            print("dns pending:", hostname, f"(attempt {attempt}/{attempts})")
            time.sleep(10)
    return False


def main() -> int:
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if not token:
        print("skip: CLOUDFLARE_API_TOKEN missing")
        return 0

    zone_id = ensure_zone(token)
    if not zone_id:
        print("failed to ensure cloudflare zone", file=sys.stderr)
        return 1

    ensure_apex_a_record(token, zone_id)
    if not attach_worker_domain(token, zone_id):
        return 1

    target = app_dns_target(token, zone_id)
    if not target:
        # Fallback: Workers custom domain on external DNS often uses CDN target.
        target = f"{HOSTNAME}.cdn.cloudflare.net"
        print("fallback cname target:", target)

    spaceship_upsert_app_cname(target)

    if wait_dns(HOSTNAME, attempts=6):
        health = requests.get(f"https://{HOSTNAME}/api/health", timeout=20)
        print("health", health.status_code, health.text[:200])
        if health.ok and '"ok":true' in health.text:
            print("ZONE_ID=" + zone_id)
            return 0

    print("ZONE_ID=" + zone_id)
    print(
        "dns: add at Spaceship (if not done): app CNAME ->",
        target,
        "| or move NS to Cloudflare nameservers from dashboard",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
