#!/usr/bin/env python3
import re

import requests
import urllib3

urllib3.disable_warnings()

SUB = "njo34e9bouf9uy0o"
redirect = requests.get(
    f"https://app.fixvp.xyz/api/redirect/happ?sid={SUB}",
    timeout=20,
)
match = re.search(r'happ://[^"\']+', redirect.text)
print("redirect deeplink:", match.group(0) if match else "MISSING")
if match:
    print("uses_add", match.group(0).startswith("happ://add/https://31.76.2.248"))
    print("uses_install_sub", "install-sub" in match.group(0))

panel = requests.get(
    f"https://fixvp.xyz:2096/sub/{SUB}",
    verify=False,
    timeout=20,
)
print("panel status", panel.status_code, "ct", panel.headers.get("content-type"))
print("panel is_html", panel.text.strip().startswith("<"))
print("panel looks_b64", bool(re.match(r"^[A-Za-z0-9+/=\s]+$", panel.text.strip()[:200])))
