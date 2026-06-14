#!/usr/bin/env python3
import base64
import re

import requests
import urllib3

urllib3.disable_warnings()

SUB = "njo34e9bouf9uy0o"
URLS = [
    f"https://31.76.2.248:2096/sub/{SUB}",
    f"https://fixvp.xyz:2096/sub/{SUB}",
]


def check(url: str) -> None:
    print("===", url)
    try:
        r = requests.get(url, verify=False, timeout=20)
        print("status", r.status_code, "len", len(r.text), "ct", r.headers.get("content-type"))
        text = r.text.strip()
        if text.startswith("<"):
            print("HTML!", text[:80])
            return
        try:
            body = base64.b64decode(text).decode("utf-8", "replace")
            lines = [ln for ln in body.splitlines() if re.match(r"^(vless|trojan|vmess)", ln.strip(), re.I)]
            print("decoded protocols", len(lines))
            for ln in lines[:3]:
                print(" ", ln[:100])
        except Exception as exc:
            print("b64 decode", exc, text[:60])
    except Exception as exc:
        print("ERR", exc)


def main() -> None:
    for url in URLS:
        check(url)


if __name__ == "__main__":
    main()
