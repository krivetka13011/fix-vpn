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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from d1_utils import (
    d1_execute,
    fetch_subscriptions,
    kv_set_subcache,
    panel_sync_disabled,
    patch_subscription,
    require_d1_env,
)
from panel_enable_utils import enable_inbound_clients, force_enable_panel_client

urllib3.disable_warnings()

INBOUND_IDS = [19, 20, 21, 24]
PROTECTED_EMAILS = {
    "lv",
    "max-mobile",
    "egor-mobile",
    "max-pc",
    "iv",
    "egor-pc",
    "Ba-mobile",
    "Ba-pc",
    "mom-mobile",
    "Sanya-mobile",
}


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


def dedupe_panel_clients(session, base, clients, rows):
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


def limit_ip_for_row(row):
    if str(row.get("plan_type") or "") == "personal":
        return 0
    return 1 + int(row.get("extra_devices") or 0)


def subscription_expiry_ms(row):
    ends_at = str(row.get("ends_at") or "").strip()
    if not ends_at:
        return 0
    try:
        end = datetime.strptime(ends_at, "%Y-%m-%d").replace(
            hour=23, minute=59, second=59, tzinfo=timezone.utc
        )
        return int(end.timestamp() * 1000)
    except Exception:
        return 0


def panel_client_payload(panel, row, tg_id, *, expiry_ms=None, limit_ip=None):
    resolved_expiry = expiry_ms
    if resolved_expiry is None:
        resolved_expiry = subscription_expiry_ms(row) or int(panel.get("expiryTime") or 0)
    return {
        "id": panel.get("uuid") or row.get("xray_uuid"),
        "email": panel.get("email") or str(tg_id),
        "subId": panel.get("subId") or row.get("xray_sub_id"),
        "limitIp": limit_ip if limit_ip is not None else limit_ip_for_row(row),
        "expiryTime": resolved_expiry,
        "enable": True,
        "tgId": int(tg_id or 0),
        "totalGB": 0,
        "flow": "",
    }


def update_panel_client(session, base, client):
    email = str(client.get("email") or "").strip()
    if not email:
        return False
    response = session.post(
        f"{base}/panel/api/clients/update/{email}",
        json={"email": email, "inboundIds": INBOUND_IDS, "client": client},
        timeout=30,
    )
    return response.ok or "success" in response.text.lower()


def update_panel_client_sub_id(session, base, panel, new_sub_id, tg_id, limit_ip=1):
    email = str(panel.get("email") or "").strip()
    client = {
        "id": panel.get("uuid"),
        "email": email,
        "subId": new_sub_id,
        "limitIp": limit_ip,
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
    ok = response.ok or "success" in response.text.lower()
    if ok:
        enable_inbound_clients(session, base, int(tg_id), email)
    return ok


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
            if update_panel_client_sub_id(session, base, panel, target_sub, tg_id, limit_ip_for_row(row)):
                panel["subId"] = target_sub
                print("repaired stale subId", tg_id, target_sub)

    if panel:
        force_enable_panel_client(session, base, tg_id, panel.get("email") or str(tg_id), row)
        return panel

    email = str(tg_id)
    sub_id = str(row.get("xray_sub_id") or "").strip() or random_sub_id()
    client_uuid = str(row.get("xray_uuid") or "").strip() or str(uuid.uuid4())
    add_panel_client(session, base, email, sub_id, client_uuid, tg_id, limit_ip_for_row(row))
    force_enable_panel_client(session, base, tg_id, email, row)
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
    from d1_utils import load_env as _load

    _load(path)


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


def find_inbound_client_rows(session, base, tg_id, email_hint=None):
    hint = str(email_hint or tg_id).strip()
    hits = []
    for inbound_id in INBOUND_IDS:
        payload = session.get(f"{base}/panel/api/inbounds/get/{inbound_id}", timeout=30).json()
        if not payload.get("success"):
            continue
        settings = payload["obj"]["settings"]
        if isinstance(settings, str):
            settings = json.loads(settings)
        for client in settings.get("clients", []):
            email = str(client.get("email", ""))
            tg = int(client.get("tgId") or 0)
            if tg == int(tg_id) or email == hint:
                hits.append((inbound_id, client, email))
    return hits


def clear_pending_panel_ips(session: requests.Session, base: str) -> int:
    pending = fetch_subscriptions(
        "s.panel_ip_clear_requested_at IS NOT NULL AND s.client_email IS NOT NULL"
    )
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
            patch_subscription(
                str(row["user_id"]),
                {
                    "panel_ip_clear_requested_at": None,
                    "last_device_reset": datetime.now(timezone.utc).isoformat(),
                },
            )
            cleared += 1
            print("cleared panel ips for", email)
    return cleared


def clear_stuck_swap_flags() -> int:
    try:
        cleared = d1_execute(
            "UPDATE subscriptions SET panel_sub_rotate_requested_at = NULL, "
            "pending_xray_sub_id = NULL "
            "WHERE panel_sub_rotate_requested_at IS NOT NULL OR pending_xray_sub_id IS NOT NULL"
        )
    except Exception as error:
        print("clear_stuck_swap_flags warn:", error)
        cleared = 0
    if cleared:
        print("cleared stuck rotation flags", cleared)
    return cleared


def process_pending_sub_rotations(session: requests.Session, base: str, clients: list, worker: str) -> int:
    try:
        pending_rows = fetch_subscriptions(
            "s.pending_xray_sub_id IS NOT NULL AND s.client_email IS NOT NULL"
        )
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
            "limitIp": limit_ip_for_row(row),
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
        patch_subscription(str(row["user_id"]), patch)
        if links:
            kv_set_subcache(
                str(row["user_id"]),
                "\n".join(str(line).strip() for line in links if str(line).strip()),
            )
        rotated += 1
        print("rotated subId", email, new_sub_id)
    return rotated


def sync_client_limits(session: requests.Session, base: str, clients: list) -> int:
    rows = fetch_subscriptions("s.status = 'active' AND s.client_email IS NOT NULL")
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
        limit_ip = limit_ip_for_row(row)
        if int(panel.get("limitIp") or -1) == limit_ip:
            continue
        client = panel_client_payload(
            panel,
            row,
            tg_id,
            limit_ip=limit_ip,
            expiry_ms=int(panel.get("expiryTime") or 0) or subscription_expiry_ms(row),
        )
        update_email = panel.get("email") or email
        if update_panel_client(session, base, {**client, "email": update_email}):
            synced += 1
            print("sync limitIp", update_email, limit_ip)
    return synced


def sync_active_panel_clients(session: requests.Session, base: str, clients: list) -> int:
    rows = fetch_subscriptions("s.status = 'active' AND s.client_email IS NOT NULL")
    by_email = {str(c.get("email") or ""): c for c in clients}
    by_tg = {}
    for c in clients:
        tg = str(c.get("tgId") or "")
        if tg:
            by_tg[tg] = c

    synced = 0
    for row in rows:
        email = str(row.get("client_email") or "").strip()
        tg_id = int((row.get("users") or {}).get("telegram_id") or 0)
        if not tg_id:
            continue
        panel = by_email.get(email) or by_tg.get(str(tg_id))
        if not panel:
            continue
        client = panel_client_payload(panel, row, tg_id)
        if update_panel_client(session, base, client):
            enable_inbound_clients(session, base, tg_id, email)
            synced += 1
            print("sync active panel", tg_id, "enable expiry", client["expiryTime"])
    return synced


def build_client_index(clients: list) -> tuple[dict[str, dict], dict[str, dict]]:
    by_email: dict[str, dict] = {}
    by_tg: dict[str, dict] = {}
    for row in clients:
        email = str(row.get("email") or "").strip()
        tg = str(row.get("tgId") or "").strip()
        if email:
            by_email[email] = row
        if tg:
            by_tg[tg] = row
    return by_email, by_tg


def needs_panel_work(row: dict, by_email: dict[str, dict], by_tg: dict[str, dict]) -> bool:
    if row.get("pending_xray_sub_id") or row.get("panel_ip_clear_requested_at"):
        return True
    if row.get("panel_sub_rotate_requested_at"):
        return True
    user = row.get("users") or {}
    tg_id = int(user.get("telegram_id") or 0)
    if not tg_id:
        return False
    sub_id = str(row.get("xray_sub_id") or "").strip()
    if not sub_id:
        return True
    email = str(row.get("client_email") or tg_id).strip()
    return email not in by_email and str(tg_id) not in by_tg and str(tg_id) not in by_email


def main():
    if panel_sync_disabled():
        print("PANEL_SYNC_DISABLED — skip panel API")
        return

    require_d1_env()
    worker = os.environ.get("WEBAPP_URL", "https://app.fixvp.xyz").rstrip("/")
    full_sync = os.environ.get("PROVISION_FULL_SYNC", "").strip() == "1"

    rows = fetch_subscriptions()

    session, base = panel_session()
    flags_cleared = clear_stuck_swap_flags()
    ip_cleared = clear_pending_panel_ips(session, base)
    clients = dedupe_clients_index(scan_clients(session, base))
    by_email, by_tg = build_client_index(clients)

    dupes_removed = 0
    limits_synced = 0
    active_synced = 0
    if full_sync:
        dupes_removed = dedupe_panel_clients(session, base, clients, rows)
        if dupes_removed:
            clients = dedupe_clients_index(scan_clients(session, base))
            by_email, by_tg = build_client_index(clients)

    sub_rotated = process_pending_sub_rotations(session, base, clients, worker)
    if full_sync:
        limits_synced = sync_client_limits(session, base, clients)
        active_synced = sync_active_panel_clients(session, base, clients)

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
        if not needs_panel_work(row, by_email, by_tg) and not full_sync:
            continue

        user = row.get("users") or {}
        tg_id = int(user.get("telegram_id") or 0)
        if not tg_id:
            continue
        user_id = row["user_id"]

        panel = ensure_panel_client(
            session, base, clients, row, worker, sub_links, panel_live
        )
        force_enable_panel_client(session, base, tg_id, str(tg_id), row)
        by_email[str(panel.get("email") or tg_id)] = panel
        by_tg[str(tg_id)] = panel

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
            kv_set_subcache(
                user_id,
                "\n".join(str(line).strip() for line in links if str(line).strip()),
            )
        else:
            print("warn empty cache", tg_id, sub_id)
        patch_subscription(user_id, patch)
        provisioned += 1

    print(
        f"provisioned {provisioned}/{len(rows)} (full_sync={full_sync}), "
        f"flags {flags_cleared}, ip_clears {ip_cleared}, dupes {dupes_removed}, "
        f"rotations {sub_rotated}, limits {limits_synced}, active {active_synced}"
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("FAIL:", error, file=sys.stderr)
        sys.exit(1)
