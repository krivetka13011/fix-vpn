"""Shared helpers: keep 3X-UI panel clients enabled (global + per-inbound)."""
from __future__ import annotations

import json
from datetime import datetime, timezone

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
}


def subscription_expiry_ms(row: dict | None) -> int:
    ends_at = str((row or {}).get("ends_at") or "").strip()
    if not ends_at:
        return 0
    try:
        end = datetime.strptime(ends_at, "%Y-%m-%d").replace(
            hour=23, minute=59, second=59, tzinfo=timezone.utc
        )
        return int(end.timestamp() * 1000)
    except Exception:
        return 0


def limit_ip_for_row(row: dict | None) -> int:
    row = row or {}
    if str(row.get("plan_type") or "") == "personal":
        return 0
    return 1 + int(row.get("extra_devices") or 0)


def panel_client_payload(panel: dict, row: dict | None, tg_id: int) -> dict:
    row = row or {}
    return {
        "id": panel.get("uuid") or row.get("xray_uuid"),
        "email": panel.get("email") or str(tg_id),
        "subId": panel.get("subId") or row.get("xray_sub_id"),
        "limitIp": int(panel.get("limitIp") or limit_ip_for_row(row) or 1),
        "expiryTime": int(panel.get("expiryTime") or 0) or subscription_expiry_ms(row),
        "enable": True,
        "tgId": int(tg_id or 0),
        "totalGB": 0,
        "flow": "",
    }


def update_panel_client(session, base: str, client: dict) -> bool:
    email = str(client.get("email") or "").strip()
    if not email:
        return False
    response = session.post(
        f"{base}/panel/api/clients/update/{email}",
        json={"email": email, "inboundIds": INBOUND_IDS, "client": client},
        timeout=30,
    )
    return response.ok or "success" in response.text.lower()


def scan_client_enable_state(session, base: str, tg_id: int, email_hint: str) -> dict:
    hint = str(email_hint or tg_id).strip()
    inbound_rows = []
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
                inbound_rows.append(
                    {
                        "inbound": inbound_id,
                        "email": email,
                        "enable": bool(client.get("enable")),
                        "subId": str(client.get("subId") or ""),
                        "uuid": str(client.get("id") or ""),
                        "limitIp": int(client.get("limitIp") or 0),
                        "expiryTime": int(client.get("expiryTime") or 0),
                        "obj": payload["obj"],
                        "settings": settings,
                        "client": client,
                    }
                )
    global_enable = None
    try:
        row = session.get(f"{base}/panel/api/clients/get/{hint}", timeout=30).json()
        client = (row.get("obj") or {}).get("client") or {}
        global_enable = bool(client.get("enable"))
    except Exception:
        pass
    return {
        "inbound_rows": inbound_rows,
        "global_enable": global_enable,
        "any_inbound_disabled": any(not r["enable"] for r in inbound_rows),
    }


def enable_inbound_clients(session, base: str, tg_id: int, email_hint: str) -> int:
    """UI toggle reads from inbound settings — force enable:true on each inbound."""
    hint = str(email_hint or tg_id).strip()
    fixed = 0
    for inbound_id in INBOUND_IDS:
        response = session.get(f"{base}/panel/api/inbounds/get/{inbound_id}", timeout=30)
        payload = response.json()
        if not payload.get("success"):
            continue
        obj = payload["obj"]
        settings = obj["settings"]
        if isinstance(settings, str):
            settings = json.loads(settings)
        clients = settings.get("clients", [])
        touched = False
        for client in clients:
            email = str(client.get("email", ""))
            tg = int(client.get("tgId") or 0)
            if tg != int(tg_id) and email != hint:
                continue
            if client.get("enable") is True:
                continue
            client["enable"] = True
            if not client.get("tgId"):
                client["tgId"] = int(tg_id)
            touched = True
        if not touched:
            continue
        update_body = {**obj, "settings": json.dumps({**settings, "clients": clients})}
        for key in list(update_body.keys()):
            if update_body[key] is None:
                del update_body[key]
        update = session.post(
            f"{base}/panel/api/inbounds/update/{inbound_id}",
            json=update_body,
            timeout=30,
        )
        if update.ok or "success" in update.text.lower():
            fixed += 1
    return fixed


def force_enable_panel_client(
    session,
    base: str,
    tg_id: int,
    email_hint: str | None = None,
    subscription_row: dict | None = None,
) -> bool:
    tg_id = int(tg_id)
    email = str(email_hint or tg_id).strip()
    if email in PROTECTED_EMAILS:
        return True

    state = scan_client_enable_state(session, base, tg_id, email)
    rows = state["inbound_rows"]
    panel = {
        "email": rows[0]["email"] if rows else email,
        "uuid": rows[0]["uuid"] if rows else None,
        "subId": rows[0]["subId"] if rows else None,
        "expiryTime": rows[0]["expiryTime"] if rows else 0,
        "limitIp": rows[0]["limitIp"] if rows else 1,
    }
    client = panel_client_payload(panel, subscription_row, tg_id)
    global_ok = update_panel_client(session, base, client)
    inbound_fixed = enable_inbound_clients(session, base, tg_id, email)

    needs_work = (
        state["any_inbound_disabled"]
        or state["global_enable"] is False
        or not global_ok
    )
    if global_ok or inbound_fixed > 0:
        print(
            f"force_enable {tg_id} global={global_ok} inbound_fixed={inbound_fixed} "
            f"expiry={client['expiryTime']}"
        )
        return True
    if needs_work:
        print(f"force_enable failed {tg_id}", file=__import__("sys").stderr)
    return False
