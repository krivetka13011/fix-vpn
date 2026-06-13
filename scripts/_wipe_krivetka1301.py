"""Fully wipe Krivetka1301 from DB — as if never pressed /start. Panel is NOT touched."""
import json
import os
import sys

import requests

USERNAME = "Krivetka1301"
TG_ID = 1159166497


def load_env(path="project_config.env"):
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ[key.strip()] = value.strip()


def sb_headers(prefer="return=representation"):
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": prefer,
    }


def main():
    load_env()
    sb = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1/"

    users = requests.get(
        f"{sb}users?or=(telegram_id.eq.{TG_ID},username.eq.{USERNAME})&select=id,telegram_id,username",
        headers=sb_headers(),
        timeout=30,
    ).json()

    if not users:
        print("OK: user not found, already clean")
        return

    for user in users:
        uid = user["id"]
        print("wiping", user.get("username"), user.get("telegram_id"), uid)

        for table, col in (
            ("bot_sessions", "telegram_id"),
            ("vpn_device_bindings", "user_id"),
            ("xui_client_inbounds", "user_id"),
            ("addon_purchases", "user_id"),
            ("transactions", "user_id"),
        ):
            r = requests.delete(
                f"{sb}{table}",
                headers=sb_headers("return=minimal"),
                params={col: f"eq.{TG_ID if col == 'telegram_id' else uid}"},
                timeout=30,
            )
            print(" ", table, r.status_code)

        r = requests.delete(
            f"{sb}users?id=eq.{uid}",
            headers=sb_headers("return=minimal"),
            timeout=30,
        )
        print(" delete user", r.status_code)

    left = requests.get(
        f"{sb}users?or=(telegram_id.eq.{TG_ID},username.eq.{USERNAME})&select=id",
        headers=sb_headers(),
        timeout=30,
    ).json()
    if left:
        raise RuntimeError(f"user still exists: {json.dumps(left)}")

    subs = requests.get(
        f"{sb}subscriptions?select=id,user_id&limit=5",
        headers=sb_headers(),
        timeout=30,
    ).json()
    orphan = [s for s in subs if s.get("user_id") not in {u["id"] for u in users}]
    print("OK wiped. subscriptions left in project:", len(subs))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("FAIL:", error, file=sys.stderr)
        sys.exit(1)
