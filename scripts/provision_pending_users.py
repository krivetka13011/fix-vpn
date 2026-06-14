"""Create panel clients for DB users missing xray_sub_id (runs outside Cloudflare Worker)."""
import json
import os
import random
import string
import sys
import uuid
from datetime import datetime, timezone

import requests
import urllib3

urllib3.disable_warnings()

INBOUND_IDS = [19, 20, 21, 24]
PROTECTED_EMAILS = {"lv", "max-mobile", "egor-mobile", "max-pc"}


def dedupe_clients_index(clients):
    """scan_clients returns one row per inbound — keep one row per client uuid."""
    by_uuid = {}
    for row in clients:
        uid = str(row.get("uuid") or "").strip()
        if not uid:
            continue
        if uid not in by_uuid:
            by_uuid[uid] = row
    return list(by_uuid.values())


def find_all_panel_clients(clients, telegram_id, username):
    tg = str(telegram_id)
    hits = []
    seen = set()
    for row in clients:
        uid = str(row.get("uuid") or "")
        if uid in seen:
            continue
        if str(row.get("tgId") or "") == tg or str(row.get("email") or "") == tg:
            hits.append(row)
            seen.add(uid)
        elif username and str(row.get("email") or "") == username:
            hits.append(row)
            seen.add(uid)
    return hits


def pick_canonical_client(candidates, db_row):
    db_uuid = str((db_row or {}).get("xray_uuid") or "").strip()
    db_sub = str((db_row or {}).get("xray_sub_id") or "").strip()
    pending = str((db_row or {}).get("pending_xray_sub_id") or "").strip()
    if db_uuid:
        for client in candidates:
            if str(client.get("uuid") or "") == db_uuid:
                return client
    if pending:
        for client in candidates:
            if str(client.get("subId") or "") == pending:
                return client
    if db_sub:
        for client in candidates:
            if str(client.get("subId") or "") == db_sub:
                return client
    return candidates[0]


def delete_panel_client(session, base, email):
    email = str(email or "").strip()
    if not email or email in PROTECTED_EMAILS:
        return False
    response = session.post(
        f"{base}/panel/api/clients/del/{email}",
        json={},
        timeout=30,
    )
    return response.ok or "success" in response.text.lower()


def dedupe_panel_clients(sb, session, base, clients, rows):
    unique = dedupe_clients_index(clients)
    db_by_tg = {}
    for row in rows:
        user = row.get("users") or {}
        tg_id = int(user.get("telegram_id") or 0)
        if tg_id:
            db_by_tg[str(tg_id)] = row

    removed = 0
    grouped = {}
    for client in unique:
        tg = str(client.get("tgId") or "").strip()
        if not tg and str(client.get("email") or "").isdigit():
            tg = str(client.get("email") or "")
        if not tg:
            continue
        grouped.setdefault(tg, []).append(client)

    for tg, hits in grouped.items():
        if len(hits) <= 1:
            continue
        canonical = pick_canonical_client(hits, db_by_tg.get(tg))
        for duplicate in hits:
            if str(duplicate.get("uuid") or "") == str(canonical.get("uuid") or ""):
                continue
            email = str(duplicate.get("email") or "")
            if delete_panel_client(session, base, email):
                removed += 1
                print("removed duplicate panel client", email, "tg", tg)
    return removed


def update_panel_client_sub_id(session, base, panel, new_sub_id, tg_id):
    email = str(panel.get("email") or "").strip()
    client = {
        "id": panel.get("uuid"),
        "email": email,
        "subId": new_sub_id,
        "limitIp": 0,
        "expiryTime": 0,
        "enable": True,
        "tgId": int(tg_id or 0),
        "totalGB": 0,
        "flow": "",
    }
    response = session.post(
        f"{base}/panel/api/clients/update/{email}",
        json={"email": email, "inboundIds": INBOUND_IDS, "client": client},
        timeout=30,
    )
    return response.ok or "success" in response.text.lower()


def limit_ip_for_row(_row):
    return 0


def ensure_panel_client(session, base, clients, row, worker, sub_links_fn, panel_live_fn):
    user = row.get("users") or {}
    tg_id = int(user.get("telegram_id") or 0)
    username = user.get("username")
    unique = dedupe_clients_index(clients)
    matches = find_all_panel_clients(unique, tg_id, username)

    panel = pick_canonical_client(matches, row) if matches else None

    if panel and not panel_live_fn(panel):
        target_sub = (
            str(row.get("pending_xray_sub_id") or "").strip()
            or str(row.get("xray_sub_id") or "").strip()
            or str(panel.get("subId") or "").strip()
        )
        if target_sub and target_sub != str(panel.get("subId") or ""):
            if update_panel_client_sub_id(session, base, panel, target_sub, tg_id):
                panel["subId"] = target_sub
                print("repaired stale subId", tg_id, target_sub)

    if panel:
        return panel

    email = str(tg_id)
    sub_id = str(row.get("xray_sub_id") or "").strip() or random_sub_id()
    client_uuid = str(row.get("xray_uuid") or "").strip() or str(uuid.uuid4())
    add_panel_client(session, base, email, sub_id, client_uuid, tg_id, limit_ip_for_row(row))
    refreshed = dedupe_clients_index(scan_clients(session, base))
    panel = find_panel_client(refreshed, tg_id, username)
    if not panel:
        panel = {
            "email": email,
            "subId": sub_id,
            "uuid": client_uuid,
        }
        print("created", tg_id, sub_id)
    else:
        print("found after create", tg_id, panel["subId"])
    return panel


def load_env(path="project_config.env"):
    if not os.path.isfile(path):
        return
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


def sb_headers(prefer="return=minimal"):
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": prefer,
    }


def random_sub_id(length=16):
    alphabet = string.ascii_lowercase + string.digits
    return "".join(random.choice(alphabet) for _ in range(length))


def panel_session():
    base = os.environ["XUI_BASE_URL"].rstrip("/")
    token = os.environ["XUI_API_TOKEN"]
    session = requests.Session()
    session.verify = False
    session.headers.update(
        {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
    )
    return session, base


def scan_clients(session, base):
    found = []
    for inbound_id in INBOUND_IDS:
        response = session.get(f"{base}/panel/api/inbounds/get/{inbound_id}", timeout=30)
        payload = response.json()
        if not payload.get("success"):
            continue
        settings = payload["obj"]["settings"]
        if isinstance(settings, str):
            settings = json.loads(settings)
        for client in settings.get("clients", []):
            found.append(
                {
                    "inbound": inbound_id,
                    "email": str(client.get("email", "")),
                    "tgId": client.get("tgId"),
                    "subId": str(client.get("subId") or ""),
                    "uuid": str(client.get("id") or ""),
                    "limitIp": int(client.get("limitIp") or 0),
                }
            )
    return found


def find_panel_client(clients, telegram_id, username):
    tg = str(telegram_id)
    for row in clients:
        if str(row.get("tgId") or "") == tg:
            return row
        if row.get("email") == tg:
            return row
    if username:
        for row in clients:
            if row.get("email") == username:
                return row
    return None


def add_panel_client(session, base, email, sub_id, client_uuid, tg_id, limit_ip=1):
    client = {
        "id": client_uuid,
        "email": email,
        "subId": sub_id,
        "limitIp": limit_ip,
        "expiryTime": 0,
        "enable": True,
        "tgId": tg_id,
        "totalGB": 0,
        "flow": "",
    }
    response = session.post(
        f"{base}/panel/api/clients/add",
        json={"inboundIds": INBOUND_IDS, "client": client},
        timeout=30,
    )
    data = response.json()
    if data.get("success"):
        return True
    if "already in use" in str(data.get("msg", "")).lower():
        return True
    raise RuntimeError(data)


def clear_pending_panel_ips(sb: str, session: requests.Session, base: str) -> int:
    pending = requests.get(
        sb
        + "subscriptions?panel_ip_clear_requested_at=not.is.null&select=user_id,client_email&client_email=not.is.null",
        headers={**sb_headers("return=representation"), "Prefer": "return=representation"},
        timeout=30,
    ).json()
    cleared = 0
    for row in pending:
        email = str(row.get("client_email") or "").strip()
        if not email:
            continue
        response = session.post(
            f"{base}/panel/api/inbounds/clearClientIps/{email}",
            json={},
            timeout=30,
        )
        if not response.ok:
            response = session.post(
                f"{base}/panel/api/clients/clearIps/{email}",
                json={},
                timeout=30,
            )
        if response.ok or "success" in response.text.lower():
            requests.patch(
                sb + f"subscriptions?user_id=eq.{row['user_id']}",
                headers=sb_headers(),
                json={
                    "panel_ip_clear_requested_at": None,
                    "last_device_reset": datetime.now(timezone.utc).isoformat(),
                },
                timeout=30,
            )
            cleared += 1
            print("cleared panel ips for", email)
    return cleared


def clear_stuck_swap_flags(sb: str) -> int:
    cleared = 0
    try:
        response = requests.patch(
            sb
            + "subscriptions?or=(panel_sub_rotate_requested_at.not.is.null,pending_xray_sub_id.not.is.null)",
            headers={**sb_headers("return=representation"), "Prefer": "return=representation"},
            json={
                "panel_sub_rotate_requested_at": None,
                "pending_xray_sub_id": None,
            },
            timeout=30,
        )
        if response.ok:
            payload = response.json()
            if isinstance(payload, list):
                cleared = len(payload)
    except Exception as error:
        print("clear_stuck_swap_flags warn:", error)
    if cleared:
        print("cleared stuck rotation flags", cleared)
    return cleared


def process_pending_sub_rotations(sb: str, session: requests.Session, base: str, clients: list, worker: str) -> int:
    try:
        pending = requests.get(
            sb
            + "subscriptions?pending_xray_sub_id=not.is.null&select=user_id,client_email,pending_xray_sub_id,xray_uuid,users!inner(telegram_id)&client_email=not.is.null",
            headers={**sb_headers("return=representation"), "Prefer": "return=representation"},
            timeout=30,
        )
        if not pending.ok:
            return 0
        pending_rows = pending.json()
    except Exception as error:
        print("process_pending_sub_rotations skip:", error)
        return 0

    by_email = {str(c.get("email") or ""): c for c in clients}
    rotated = 0
    for row in pending_rows:
        email = str(row.get("client_email") or "").strip()
        new_sub_id = str(row.get("pending_xray_sub_id") or "").strip()
        if not email or not new_sub_id:
            continue
        panel = by_email.get(email)
        tg_id = int((row.get("users") or {}).get("telegram_id") or 0)
        client = {
            "id": (panel or {}).get("uuid") or row.get("xray_uuid"),
            "email": (panel or {}).get("email") or email,
            "subId": new_sub_id,
            "limitIp": 0,
            "expiryTime": 0,
            "enable": True,
            "tgId": tg_id,
            "totalGB": 0,
            "flow": "",
        }
        response = session.post(
            f"{base}/panel/api/clients/update/{email}",
            json={"email": email, "inboundIds": INBOUND_IDS, "client": client},
            timeout=30,
        )
        if not (response.ok or "success" in response.text.lower()):
            print("rotate failed", email, response.text[:200])
            continue
        links = []
        try:
            links = session.get(f"{base}/panel/api/clients/subLinks/{new_sub_id}", timeout=30).json().get("obj") or []
        except Exception:
            pass
        patch = {
            "xray_sub_id": new_sub_id,
            "subscription_url": f"{worker}/api/sub/{new_sub_id}",
            "pending_xray_sub_id": None,
            "panel_sub_rotate_requested_at": None,
            "panel_ip_clear_requested_at": None,
        }
        if links:
            patch["subscription_payload_cache"] = "\n".join(
                str(line).strip() for line in links if str(line).strip()
            )
        requests.patch(
            sb + f"subscriptions?user_id=eq.{row['user_id']}",
            headers=sb_headers(),
            json=patch,
            timeout=30,
        )
        rotated += 1
        print("rotated subId", email, new_sub_id)
    return rotated


def sync_client_limits(sb: str, session: requests.Session, base: str, clients: list) -> int:
    rows = requests.get(
        sb
        + "subscriptions?status=eq.active&select=user_id,client_email,plan_type,extra_devices,xray_uuid,xray_sub_id,users!inner(telegram_id)&client_email=not.is.null",
        headers={**sb_headers("return=representation"), "Prefer": "return=representation"},
        timeout=30,
    ).json()
    by_email = {str(c.get("email") or ""): c for c in clients}
    by_tg = {}
    for c in clients:
        tg = str(c.get("tgId") or "")
        if tg:
            by_tg[tg] = c

    synced = 0
    for row in rows:
        email = str(row.get("client_email") or "").strip()
        tg_id = str((row.get("users") or {}).get("telegram_id") or "")
        panel = by_email.get(email) or by_tg.get(tg_id)
        if not panel:
            continue
        limit_ip = 0
        if int(panel.get("limitIp") or -1) == limit_ip:
            continue
        client = {
            "id": panel.get("uuid") or row.get("xray_uuid"),
            "email": panel.get("email") or email,
            "subId": panel.get("subId") or row.get("xray_sub_id"),
            "limitIp": limit_ip,
            "expiryTime": 0,
            "enable": True,
            "tgId": int(tg_id or 0),
            "totalGB": 0,
            "flow": "",
        }
        update_email = panel.get("email") or email
        response = session.post(
            f"{base}/panel/api/clients/update/{update_email}",
            json={"email": update_email, "inboundIds": INBOUND_IDS, "client": client},
            timeout=30,
        )
        if response.ok or "success" in response.text.lower():
            synced += 1
            print("sync limitIp", update_email, limit_ip)
    return synced


def main():
    load_env()
    for name in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "XUI_BASE_URL", "XUI_API_TOKEN"):
        if not os.environ.get(name):
            raise RuntimeError(f"missing {name}")

    sb = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1/"
    worker = os.environ.get("WEBAPP_URL", "https://app.fixvp.xyz").rstrip("/")

    rows = requests.get(
        sb
        + "subscriptions?select=user_id,xray_sub_id,xray_uuid,plan_type,extra_devices,pending_xray_sub_id,subscription_payload_cache,status,users!inner(telegram_id,username)",
        headers={**sb_headers("return=representation"), "Prefer": "return=representation"},
        timeout=30,
    ).json()

    session, base = panel_session()
    flags_cleared = clear_stuck_swap_flags(sb)
    ip_cleared = clear_pending_panel_ips(sb, session, base)
    clients = dedupe_clients_index(scan_clients(session, base))
    dupes_removed = dedupe_panel_clients(sb, session, base, clients, rows)
    if dupes_removed:
        clients = dedupe_clients_index(scan_clients(session, base))
    sub_rotated = process_pending_sub_rotations(sb, session, base, clients, worker)
    limits_synced = sync_client_limits(sb, session, base, clients)

    if not rows:
        print(
            f"no users, flags {flags_cleared}, ip_clears {ip_cleared}, dupes {dupes_removed}, "
            f"rotations {sub_rotated}, limits {limits_synced}"
        )
        return

    provisioned = 0

    def panel_live(row):
        sub_id = str(row.get("subId") or "").strip()
        if not sub_id:
            return False
        return len(sub_links(session, base, sub_id)) > 0

    def sub_links(session, base, sub_id):
        response = session.get(f"{base}/panel/api/clients/subLinks/{sub_id}", timeout=30)
        if not response.ok:
            return []
        payload = response.json()
        links = payload.get("obj") or []
        return links if isinstance(links, list) else []

    for row in rows:
        user = row.get("users") or {}
        tg_id = int(user.get("telegram_id") or 0)
        if not tg_id:
            continue
        user_id = row["user_id"]

        panel = ensure_panel_client(
            session, base, clients, row, worker, sub_links, panel_live
        )
        clients = dedupe_clients_index(scan_clients(session, base))

        sub_id = str(panel.get("subId") or "").strip()
        client_uuid = str(panel.get("uuid") or "").strip()
        if not sub_id or not client_uuid:
            print("skip incomplete panel row", tg_id)
            continue

        patch = {
            "client_email": str(tg_id),
            "xray_sub_id": sub_id,
            "xray_uuid": client_uuid,
            "subscription_url": f"{worker}/api/sub/{sub_id}",
        }
        links = sub_links(session, base, sub_id)
        if links:
            patch["subscription_payload_cache"] = "\n".join(
                str(line).strip() for line in links if str(line).strip()
            )
        elif not str(row.get("subscription_payload_cache") or "").strip():
            print("warn empty cache", tg_id, sub_id)
        requests.patch(
            sb + f"subscriptions?user_id=eq.{user_id}",
            headers=sb_headers(),
            json=patch,
            timeout=30,
        )
        provisioned += 1

    print(
        f"provisioned {provisioned}/{len(rows)}, flags {flags_cleared}, ip_clears {ip_cleared}, "
        f"dupes {dupes_removed}, rotations {sub_rotated}, limits {limits_synced}"
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("FAIL:", error, file=sys.stderr)
        sys.exit(1)
