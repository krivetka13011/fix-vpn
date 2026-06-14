#!/usr/bin/env python3
"""Enable Cloudflare proxy + WAF bypass for sub.fixvp.xyz subscription endpoint."""
from __future__ import annotations

import json
import os
import sys
import time

import requests

ZONE_NAME = os.environ.get("PUBLIC_ZONE_NAME", "fixvp.xyz")
SUB_HOST = os.environ.get("SUB_HOSTNAME", "sub.fixvp.xyz")
SUB_LABEL = os.environ.get("SUB_DNS_NAME", "sub")
ORIGIN_IP = os.environ.get("SUB_ORIGIN_IP", "31.76.2.248")
WAF_RULE_DESC = "Allow Happ VPN subscriptions (/sub/)"


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
        return zone_id
    payload = cf_api(token, "GET", f"/zones?name={ZONE_NAME}")
    zones = payload.get("result") or []
    return zones[0]["id"] if zones else None


def ensure_sub_dns_proxied(token: str, zone_id: str) -> bool:
    payload = cf_api(token, "GET", f"/zones/{zone_id}/dns_records?name={SUB_HOST}")
    records = payload.get("result") or []
    if not records:
        print("creating A record", SUB_HOST, "->", ORIGIN_IP, "proxied=true")
        payload = cf_api(
            token,
            "POST",
            f"/zones/{zone_id}/dns_records",
            json={
                "type": "A",
                "name": SUB_LABEL,
                "content": ORIGIN_IP,
                "ttl": 1,
                "proxied": True,
            },
        )
        return bool(payload.get("success"))

    record = records[0]
    record_id = record["id"]
    needs_update = (
        record.get("content") != ORIGIN_IP
        or record.get("type") != "A"
        or not record.get("proxied")
    )
    print(
        "dns",
        SUB_HOST,
        "content=",
        record.get("content"),
        "proxied=",
        record.get("proxied"),
    )
    if not needs_update:
        print("dns already correct")
        return True

    payload = cf_api(
        token,
        "PATCH",
        f"/zones/{zone_id}/dns_records/{record_id}",
        json={
            "type": "A",
            "name": SUB_LABEL,
            "content": ORIGIN_IP,
            "ttl": 1,
            "proxied": True,
        },
    )
    return bool(payload.get("success"))


def set_ssl_mode(token: str, zone_id: str, mode: str = "full") -> bool:
    payload = cf_api(
        token,
        "PATCH",
        f"/zones/{zone_id}/settings/ssl",
        json={"value": mode},
    )
    if payload.get("success"):
        print("ssl mode ->", mode)
        return True
    return False


def set_security_level(token: str, zone_id: str, level: str = "medium") -> bool:
    payload = cf_api(
        token,
        "PATCH",
        f"/zones/{zone_id}/settings/security_level",
        json={"value": level},
    )
    if payload.get("success"):
        print("security_level ->", level)
        return True
    return False


def disable_browser_check(token: str, zone_id: str) -> bool:
    payload = cf_api(
        token,
        "PATCH",
        f"/zones/{zone_id}/settings/browser_check",
        json={"value": "off"},
    )
    if payload.get("success"):
        print("browser_check -> off")
        return True
    return False


def upsert_waf_skip_rule(token: str, zone_id: str) -> bool:
    entry = cf_api(
        token,
        "GET",
        f"/zones/{zone_id}/rulesets/phases/http_request_firewall_custom/entrypoint",
    )
    if not entry.get("success"):
        return False

    ruleset = entry.get("result") or {}
    ruleset_id = ruleset.get("id")
    if not ruleset_id:
        print("no custom firewall entrypoint ruleset", file=sys.stderr)
        return False

    rules = list(ruleset.get("rules") or [])
    expression = '(starts_with(http.request.uri.path, "/sub/"))'
    skip_rule = {
        "description": WAF_RULE_DESC,
        "expression": expression,
        "action": "skip",
        "action_parameters": {
            "phases": [
                "http_ratelimit",
                "http_request_firewall_managed",
                "http_request_sbfm",
            ],
            "products": ["bic", "uaBlock", "hot", "securityLevel"],
        },
        "enabled": True,
    }

    replaced = False
    for index, rule in enumerate(rules):
        if rule.get("description") == WAF_RULE_DESC:
            rules[index] = {**skip_rule, "id": rule.get("id")}
            replaced = True
            break
    if not replaced:
        rules.insert(0, skip_rule)

    payload = cf_api(
        token,
        "PUT",
        f"/zones/{zone_id}/rulesets/{ruleset_id}",
        json={"rules": rules},
    )
    if payload.get("success"):
        print("waf skip rule upserted for /sub/")
        return True
    return False


def probe_subscription(sub_id: str = "njo34e9bouf9uy0o") -> bool:
    import urllib3

    urllib3.disable_warnings()
    url = f"https://{SUB_HOST}:2096/sub/{sub_id}"
    for attempt in range(1, 7):
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
        time.sleep(10)
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
        print("zone not found", file=sys.stderr)
        return 1
    print("zone_id", zone_id)

    ok = True
    ok = ensure_sub_dns_proxied(token, zone_id) and ok
    ok = set_ssl_mode(token, zone_id, "full") and ok
    ok = disable_browser_check(token, zone_id) and ok
    ok = upsert_waf_skip_rule(token, zone_id) and ok

    if not ok:
        return 1

    print("waiting for edge propagation...")
    if probe_subscription():
        print("SUCCESS: sub.fixvp.xyz:2096/sub returns base64 over valid TLS")
        return 0

    print("WARN: cloudflare configured but probe still failing — check origin :2096 from CF IPs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
