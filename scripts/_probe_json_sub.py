#!/usr/bin/env python3
import base64
import sys

import requests
import urllib3

urllib3.disable_warnings()

SUB = sys.argv[1] if len(sys.argv) > 1 else "njo34e9bouf9uy0o"


def proxy_addr(item):
    outs = item.get("outbounds", [])
    proxy = next((o for o in outs if o.get("tag") == "proxy"), {})
    st = proxy.get("settings", {})
    if st.get("address"):
        return st.get("address"), st.get("port")
    servers = st.get("servers") or []
    if servers:
        return servers[0].get("address"), servers[0].get("port")
    return None, None


def show(label, url, is_json=True):
    print(f"=== {label} {url}")
    try:
        r = requests.get(url, timeout=25, verify=False)
        print("status", r.status_code, "len", len(r.text))
        if not is_json:
            body = base64.b64decode(r.text.strip()).decode("utf-8", "replace")
            for ln in body.splitlines():
                t = ln.strip()
                if t and not t.startswith("#"):
                    print(" ", t[:140])
            return
        data = r.json()
        print("items", len(data))
        for i, item in enumerate(data):
            addr, port = proxy_addr(item)
            print(f"  [{i}] {item.get('remarks', '')[:60]} | addr={addr} port={port}")
    except Exception as exc:
        print("ERR", exc)


def main():
    show("worker_json", f"https://app.fixvp.xyz/json/{SUB}")
    show("panel_json", f"https://31.76.2.248:2096/json/{SUB}")
    show("worker_sub", f"https://app.fixvp.xyz/sub/{SUB}", is_json=False)


if __name__ == "__main__":
    main()
