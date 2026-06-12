import requests

key = open("project_config.env", encoding="utf-8").read().split(
    "SUPABASE_SERVICE_ROLE_KEY="
)[1].split("\n")[0].split("#")[0].strip()
base = "https://dtxdbniicbmmendcryst.supabase.co/rest/v1/"
headers = {
    "apikey": key,
    "Authorization": f"Bearer {key}",
    "Content-Type": "application/json",
    "Prefer": "return=minimal",
}

for table in ("bot_sessions", "xui_client_inbounds", "addon_purchases", "transactions"):
    response = requests.delete(f"{base}{table}", headers=headers, params={"id": "neq.00000000-0000-0000-0000-000000000000"})
    print(table, response.status_code)

subs = requests.get(f"{base}subscriptions?select=id", headers=headers).json()
clear = {
    "status": "none",
    "plan_label": None,
    "billing_months": None,
    "starts_at": None,
    "ends_at": None,
    "is_trial": False,
    "xray_uuid": None,
    "xray_sub_id": None,
    "subscription_url": None,
    "client_email": None,
    "vpn_key": None,
    "purchased_at": None,
    "extra_devices": 0,
}
for row in subs:
    response = requests.patch(
        f"{base}subscriptions?id=eq.{row['id']}",
        headers=headers,
        json=clear,
    )
    print("sub", row["id"][:8], response.status_code)

for tg_id in (1159166497, 1161440737, 8312175683, 8510320560):
    body = {"has_used_trial": False, "first_payment_done": False}
    if tg_id == 1159166497:
        body["is_tester"] = True
    response = requests.patch(
        f"{base}users?telegram_id=eq.{tg_id}",
        headers=headers,
        json=body,
    )
    print("user", tg_id, response.status_code)

users = requests.get(
    f"{base}users?select=telegram_id,username,is_tester,has_used_trial&order=telegram_id",
    headers={**headers, "Prefer": "return=representation"},
).json()
print("users", users)
