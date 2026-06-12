import os
import sys
import time

import requests

TG_ID = 1159166497


def load_env():
    with open("project_config.env", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ[key.strip()] = value.strip()


def main():
    load_env()
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    base = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1/"
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    user = requests.get(
        f"{base}users?telegram_id=eq.{TG_ID}&select=id,has_used_trial,is_tester&limit=1",
        headers=headers,
        timeout=30,
    ).json()[0]
    sub = requests.get(
        f"{base}subscriptions?user_id=eq.{user['id']}&select=*&limit=1",
        headers=headers,
        timeout=30,
    ).json()[0]

    assert sub.get("client_email"), "missing client_email"
    assert sub.get("xray_sub_id"), "missing xray_sub_id"
    assert sub.get("xray_uuid"), "missing xray_uuid"
    print("before", sub["status"], sub.get("subscription_url", "")[:50])

    trial_days = 3
    expiry = time.strftime("%Y-%m-%d", time.localtime(time.time() + trial_days * 86400))
    response = requests.patch(
        f"{base}subscriptions?user_id=eq.{user['id']}",
        headers={**headers, "Prefer": "return=minimal"},
        json={
            "status": "active",
            "plan_label": f"Пробный · {trial_days} дн.",
            "billing_months": 0,
            "starts_at": time.strftime("%Y-%m-%d"),
            "ends_at": expiry,
            "is_trial": True,
        },
        timeout=30,
    )
    if response.status_code >= 400:
        raise RuntimeError(response.text)

    sub = requests.get(
        f"{base}subscriptions?user_id=eq.{user['id']}&select=status,subscription_url,is_trial&limit=1",
        headers=headers,
        timeout=30,
    ).json()[0]
    assert sub["status"] == "active", sub
    url = sub["subscription_url"]
    import urllib3

    urllib3.disable_warnings()
    body = requests.get(url, verify=False, timeout=20).text
    assert len(body) > 100, "subscription empty"
    print("OK trial", url, "bytes", len(body))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("FAIL", error, file=sys.stderr)
        sys.exit(1)
