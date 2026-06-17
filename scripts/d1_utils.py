"""Cloudflare D1 + KV helpers for FIX VPN admin scripts."""
from __future__ import annotations

import json
import os
import sys
from typing import Any

import requests

DEFAULT_ACCOUNT_ID = "abd3a9f30b070ba7b27946ecb6b82945"
DEFAULT_D1_DATABASE_ID = "de753b71-e8b6-4d60-8eab-2b10ce0ed098"
DEFAULT_KV_NAMESPACE_ID = "1d9c845eb4c54a2d9db139b05104aaf3"


def load_env(path: str = "project_config.env") -> None:
    if not os.path.isfile(path):
        return
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def account_id() -> str:
    return os.environ.get("CLOUDFLARE_ACCOUNT_ID", DEFAULT_ACCOUNT_ID)


def d1_database_id() -> str:
    return os.environ.get("D1_DATABASE_ID", DEFAULT_D1_DATABASE_ID)


def kv_namespace_id() -> str:
    return os.environ.get("KV_NAMESPACE_ID", DEFAULT_KV_NAMESPACE_ID)


def cf_headers() -> dict[str, str]:
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if not token:
        raise RuntimeError("missing CLOUDFLARE_API_TOKEN")
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def d1_query(sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
    response = requests.post(
        f"https://api.cloudflare.com/client/v4/accounts/{account_id()}/d1/database/{d1_database_id()}/query",
        headers=cf_headers(),
        json={"sql": sql, "params": params or []},
        timeout=60,
    )
    payload = response.json()
    if not response.ok or not payload.get("success"):
        raise RuntimeError(f"D1 query failed: {response.status_code} {payload}")
    results = payload.get("result") or []
    if not results:
        return []
    block = results[0]
    if not block.get("success", True):
        raise RuntimeError(f"D1 SQL error: {block.get('error') or block}")
    return list(block.get("results") or [])


def d1_execute(sql: str, params: list[Any] | None = None) -> int:
    response = requests.post(
        f"https://api.cloudflare.com/client/v4/accounts/{account_id()}/d1/database/{d1_database_id()}/query",
        headers=cf_headers(),
        json={"sql": sql, "params": params or []},
        timeout=60,
    )
    payload = response.json()
    if not response.ok or not payload.get("success"):
        raise RuntimeError(f"D1 execute failed: {response.status_code} {payload}")
    results = payload.get("result") or []
    if not results:
        return 0
    block = results[0]
    if not block.get("success", True):
        raise RuntimeError(f"D1 SQL error: {block.get('error') or block}")
    meta = block.get("meta") or {}
    return int(meta.get("changes") or 0)


def count_table(table: str) -> int:
    rows = d1_query(f"SELECT COUNT(*) AS count FROM {table}")
    return int(rows[0]["count"]) if rows else 0


def wipe_customer_data() -> None:
    """Удаляет клиентские данные; partners и партнёрские таблицы не трогаем."""
    tables = [
        "vpn_device_bindings",
        "xui_client_inbounds",
        "addon_purchases",
        "transactions",
        "subscriptions",
        "users",
    ]
    for table in tables:
        changes = d1_execute(f"DELETE FROM {table}")
        print("d1", table, "deleted", changes)


def wipe_kv_customer_data() -> None:
    for prefix in ("session:", "rate:", "subcache:", "substatus:"):
        deleted = kv_clear_prefix(prefix)
        print("kv", prefix, "deleted", deleted)


def patch_row(table: str, where_col: str, where_val: Any, fields: dict[str, Any]) -> None:
    if not fields:
        return
    sets = ", ".join(f"{key} = ?" for key in fields)
    params = list(fields.values()) + [where_val]
    d1_execute(f"UPDATE {table} SET {sets} WHERE {where_col} = ?", params)


def patch_subscription(user_id: str, fields: dict[str, Any]) -> None:
    patch_row("subscriptions", "user_id", user_id, fields)


def subscription_with_user(row: dict[str, Any]) -> dict[str, Any]:
    """Плоская строка JOIN → формат как у Supabase REST (users: {...})."""
    out = dict(row)
    user = {
        "telegram_id": row.get("telegram_id"),
        "username": row.get("username"),
    }
    for key in ("telegram_id", "username"):
        out.pop(key, None)
    out["users"] = user
    return out


_SUBSCRIPTION_USER_SQL = """
SELECT
  s.user_id,
  s.client_email,
  s.xray_sub_id,
  s.xray_uuid,
  s.subscription_url,
  s.status,
  s.ends_at,
  s.starts_at,
  s.plan_type,
  s.extra_devices,
  s.pending_xray_sub_id,
  s.panel_sub_rotate_requested_at,
  s.panel_ip_clear_requested_at,
  s.expires_at,
  u.telegram_id,
  u.username
FROM subscriptions s
INNER JOIN users u ON u.id = s.user_id
"""


def fetch_subscriptions(where_sql: str = "", params: list[Any] | None = None) -> list[dict]:
    sql = _SUBSCRIPTION_USER_SQL
    if where_sql:
        sql += f" WHERE {where_sql}"
    rows = d1_query(sql, params)
    return [subscription_with_user(row) for row in rows]


def fetch_user_by_telegram_id(telegram_id: int) -> dict[str, Any] | None:
    rows = d1_query(
        "SELECT id, telegram_id, username FROM users WHERE telegram_id = ? LIMIT 1",
        [telegram_id],
    )
    return rows[0] if rows else None


def fetch_subscription_by_user_id(user_id: str) -> dict[str, Any] | None:
    rows = d1_query(
        "SELECT status, xray_sub_id FROM subscriptions WHERE user_id = ? LIMIT 1",
        [user_id],
    )
    return rows[0] if rows else None


def kv_put(key: str, value: str, expiration_ttl: int = 21_600) -> None:
    response = requests.put(
        f"https://api.cloudflare.com/client/v4/accounts/{account_id()}/storage/kv/namespaces/{kv_namespace_id()}/values/{key}",
        headers={
            "Authorization": cf_headers()["Authorization"],
            "Content-Type": "text/plain",
        },
        data=value.encode("utf-8"),
        params={"expiration_ttl": str(expiration_ttl)},
        timeout=30,
    )
    if not response.ok:
        raise RuntimeError(f"KV put failed: {response.status_code} {response.text[:200]}")


def kv_delete(key: str) -> None:
    response = requests.delete(
        f"https://api.cloudflare.com/client/v4/accounts/{account_id()}/storage/kv/namespaces/{kv_namespace_id()}/values/{key}",
        headers={"Authorization": cf_headers()["Authorization"]},
        timeout=30,
    )
    if response.status_code not in (200, 404):
        raise RuntimeError(f"KV delete failed: {response.status_code}")


def subcache_key(user_id: str) -> str:
    return f"subcache:{user_id}"


def kv_set_subcache(user_id: str, body: str) -> None:
    kv_put(subcache_key(user_id), body)


def kv_clear_subcache(user_id: str) -> None:
    kv_delete(subcache_key(user_id))


def kv_clear_prefix(prefix: str) -> int:
    """Удаляет все ключи KV с заданным префиксом (сессии, rate limits)."""
    deleted = 0
    cursor: str | None = None
    while True:
        params: dict[str, str] = {"prefix": prefix, "limit": "1000"}
        if cursor:
            params["cursor"] = cursor
        response = requests.get(
            f"https://api.cloudflare.com/client/v4/accounts/{account_id()}/storage/kv/namespaces/{kv_namespace_id()}/keys",
            headers={"Authorization": cf_headers()["Authorization"]},
            params=params,
            timeout=30,
        )
        payload = response.json()
        if not response.ok or not payload.get("success"):
            break
        result = payload.get("result") or []
        for item in result:
            name = str(item.get("name") or "")
            if name:
                kv_delete(name)
                deleted += 1
        cursor = (payload.get("result_info") or {}).get("cursor")
        if not cursor:
            break
    return deleted


def require_d1_env(*extra: str) -> None:
    load_env()
    required = ["CLOUDFLARE_API_TOKEN", "XUI_BASE_URL", "XUI_API_TOKEN", *extra]
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        print(f"missing {', '.join(missing)}", file=sys.stderr)
        raise SystemExit(1)
