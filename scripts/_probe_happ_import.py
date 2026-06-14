#!/usr/bin/env python3
import base64
import json
import re
import sys

import requests
import urllib3

urllib3.disable_warnings()

SUB = sys.argv[1] if len(sys.argv) > 1 else "njo34e9bouf9uy0o"


def main():
    urls = [
        ("json", f"https://app.fixvp.xyz/json/{SUB}"),
        ("sub", f"https://app.fixvp.xyz/sub/{SUB}"),
        ("panel_json", f"https://31.76.2.248:2096/json/{SUB}"),
        ("redirect", f"https://app.fixvp.xyz/api/redirect/happ?sid={SUB}"),
    ]
    for name, url in urls:
        print(f"=== {name} {url}")
        response = requests.get(url, timeout=25, verify=False)
        print("status", response.status_code, "ct", response.headers.get("content-type", "")[:50])
        text = response.text
        if name == "redirect":
            match = re.search(r'happ://[^"\']+', text)
            print("deeplink", match.group(0) if match else "none")
        if match:
            print("is_install_sub", "install-sub" in match.group(0))
            print("has_redirect_url", "api/redirect" in match.group(0))
            continue
        if name.endswith("json"):
            try:
                payload = response.json()
                print("json array", isinstance(payload, list), "len", len(payload))
                if payload:
                    print("keys", list(payload[0].keys())[:10])
            except json.JSONDecodeError as exc:
                print("json error", exc, text[:200])
            continue
        try:
            body = base64.b64decode(text.strip()).decode("utf-8", "replace")
            lines = [line for line in body.splitlines() if line.strip() and not line.startswith("#")]
            print("decoded lines", len(lines))
            if lines:
                print("first", lines[0][:140])
        except Exception as exc:
            print("sub error", exc, text[:140])


if __name__ == "__main__":
    main()
