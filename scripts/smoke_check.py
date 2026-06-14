"""Free project smoke test — Worker, subscription, Happ redirect, optional Telegram report.

Usage (from repo root):
  python scripts/smoke_check.py
  python scripts/smoke_check.py --notify   # send summary to Telegram (needs project_config.env)

Requires project_config.env for full checks (gitignored). Public /api/health works without it.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, field

import requests
import urllib3

urllib3.disable_warnings()

DEFAULT_WORKER = os.environ.get("WEBAPP_URL", "https://app.fixvp.xyz")
DEFAULT_TESTER_TG = 1159166497


def load_env(path: str = "project_config.env") -> bool:
    if not os.path.isfile(path):
        return False
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())
    return True


def subscription_ok(body: str) -> bool:
    text = body.strip()
    if len(text) < 200:
        return False
    if "error code:" in text or text.startswith("<!DOCTYPE"):
        return False
    cleaned = re.sub(r"^#hide-settings\s*:\s*1\s*\n?", "", text, flags=re.I).strip()
    return bool(
        re.search(r"^(vless|vmess|trojan|ss|hysteria2|tuic)://", cleaned, re.I | re.M)
    )


@dataclass
class CheckResult:
    name: str
    ok: bool
    detail: str = ""


@dataclass
class SmokeReport:
    results: list[CheckResult] = field(default_factory=list)

    def add(self, name: str, ok: bool, detail: str = "") -> None:
        self.results.append(CheckResult(name, ok, detail))

    @property
    def passed(self) -> bool:
        return all(row.ok for row in self.results)

    def lines(self) -> list[str]:
        out = []
        for row in self.results:
            mark = "OK" if row.ok else "FAIL"
            line = f"{mark} {row.name}"
            if row.detail:
                line += f" — {row.detail}"
            out.append(line)
        return out


def check_worker_health(worker: str, report: SmokeReport) -> dict | None:
    try:
        response = requests.get(f"{worker}/api/health", timeout=25)
        data = response.json() if response.ok else {}
        report.add("worker /api/health", response.ok, f"HTTP {response.status_code}")
        if response.ok:
            report.add("telegram clientBotOk", bool(data.get("clientBotOk")), "")
            report.add("telegram webhook", bool(data.get("clientWebhookOk")), data.get("clientWebhookUrl") or "")
            report.add("supabase", bool(data.get("supabaseOk")), "")
            xui_ok = bool(data.get("xuiOk"))
            report.add(
                "xui panel (optional)",
                True,
                "reachable" if xui_ok else "Worker offline to panel — normal, cron scripts handle panel",
            )
        return data if response.ok else None
    except Exception as error:
        report.add("worker /api/health", False, str(error))
        return None


def check_catalog(worker: str, report: SmokeReport) -> None:
    try:
        response = requests.get(f"{worker}/api/catalog", timeout=20)
        ok = response.ok and "tariffs" in response.text
        report.add("worker /api/catalog", ok, f"HTTP {response.status_code}")
    except Exception as error:
        report.add("worker /api/catalog", False, str(error))


def fetch_tester_sub_id(tester_tg: int) -> str | None:
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    base = os.environ.get("SUPABASE_URL", "").rstrip("/")
    if not key or not base:
        return None
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    sb = base + "/rest/v1/"
    users = requests.get(
        f"{sb}users?telegram_id=eq.{tester_tg}&select=id&limit=1",
        headers=headers,
        timeout=25,
    ).json()
    if not users:
        return None
    subs = requests.get(
        f"{sb}subscriptions?user_id=eq.{users[0]['id']}&select=status,xray_sub_id&limit=1",
        headers=headers,
        timeout=25,
    ).json()
    if not subs or subs[0].get("status") != "active":
        return None
    return str(subs[0].get("xray_sub_id") or "").strip() or None


def check_subscription_chain(worker: str, sub_id: str, report: SmokeReport) -> None:
    sub_url = f"{worker}/api/sub/{sub_id}"
    try:
        sub = requests.get(sub_url, timeout=25)
        ok = sub.status_code == 200 and subscription_ok(sub.text)
        report.add(
            "subscription /api/sub",
            ok,
            f"HTTP {sub.status_code}, {len(sub.text)} bytes",
        )
    except Exception as error:
        report.add("subscription /api/sub", False, str(error))

    try:
        redirect = requests.get(f"{worker}/api/redirect/happ?sid={sub_id}", timeout=25)
        has_crypt = "happ://crypt" in redirect.text
        report.add(
            "happ redirect",
            redirect.status_code == 200 and has_crypt,
            f"HTTP {redirect.status_code}",
        )
    except Exception as error:
        report.add("happ redirect", False, str(error))


def send_telegram_report(chat_id: int, text: str) -> bool:
    token = os.environ.get("CLIENT_BOT_TOKEN") or os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token:
        return False
    response = requests.post(
        f"https://api.telegram.org/bot{token}/sendMessage",
        json={"chat_id": chat_id, "text": text, "parse_mode": "HTML"},
        timeout=20,
    )
    data = response.json()
    return bool(data.get("ok"))


def main() -> int:
    parser = argparse.ArgumentParser(description="FIX VPN smoke check")
    parser.add_argument("--notify", action="store_true", help="Send report to Telegram")
    parser.add_argument("--worker", default=os.environ.get("WEBAPP_URL", DEFAULT_WORKER))
    parser.add_argument("--tester-tg", type=int, default=DEFAULT_TESTER_TG)
    args = parser.parse_args()

    has_env = load_env()
    worker = args.worker.rstrip("/")
    report = SmokeReport()

    check_worker_health(worker, report)
    check_catalog(worker, report)

    sub_id = None
    if has_env:
        try:
            sub_id = fetch_tester_sub_id(args.tester_tg)
            if sub_id:
                check_subscription_chain(worker, sub_id, report)
            else:
                report.add("tester subscription", False, "no active sub in DB")
        except Exception as error:
            report.add("tester subscription", False, str(error))
    else:
        report.add(
            "full subscription test",
            True,
            "skipped (create project_config.env for DB checks)",
        )

    print("FIX VPN smoke check")
    print(f"worker: {worker}")
    for line in report.lines():
        print(line)
    print("RESULT:", "PASS" if report.passed else "FAIL")

    if args.notify:
        if not has_env:
            print("notify skipped: no project_config.env", file=sys.stderr)
        else:
            status = "PASS" if report.passed else "FAIL"
            body = "<b>FIX VPN smoke</b> " + status + "\n\n" + "\n".join(report.lines())
            chat = int(os.environ.get("SMOKE_NOTIFY_CHAT_ID", str(args.tester_tg)))
            if send_telegram_report(chat, body):
                print(f"telegram report sent to {chat}")
            else:
                print("telegram notify failed", file=sys.stderr)

    return 0 if report.passed else 1


if __name__ == "__main__":
    sys.exit(main())
