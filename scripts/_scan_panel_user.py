import json
import os
import requests
import urllib3

urllib3.disable_warnings()

TG_ID = 1159166497


def load_env(path):
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ[key.strip()] = value.strip()


def main():
    load_env("project_config.env")
    base = os.environ["XUI_BASE_URL"].rstrip("/")
    token = os.environ["XUI_API_TOKEN"]
    inbound_ids = [int(x) for x in os.environ["XUI_INBOUND_IDS"].split(",")]
    session = requests.Session()
    session.verify = False
    session.headers.update({"Authorization": f"Bearer {token}"})

    hits = []
    for inbound_id in inbound_ids:
        payload = session.get(f"{base}/panel/api/inbounds/get/{inbound_id}", timeout=30).json()
        if not payload.get("success"):
            print("inbound fail", inbound_id, payload.get("msg"))
            continue
        settings = payload["obj"]["settings"]
        if isinstance(settings, str):
            settings = json.loads(settings)
        for client in settings.get("clients", []):
            email = str(client.get("email", ""))
            tg = client.get("tgId")
            sub = str(client.get("subId", ""))
            if (
                str(tg) == str(TG_ID)
                or email == str(TG_ID)
                or "1159166497" in email
                or sub in ("xiwg900oqci1smd8", "0n5regyvk6mang59")
            ):
                hits.append(
                    {
                        "inbound": inbound_id,
                        "email": email,
                        "tgId": tg,
                        "subId": sub,
                        "id": client.get("id"),
                        "enable": client.get("enable"),
                    }
                )

    print("matches", len(hits))
    for row in hits:
        print(json.dumps(row, ensure_ascii=False))

    for sub in ("xiwg900oqci1smd8", "0n5regyvk6mang59"):
        for host in ("https://fixvp.xyz:2096", "https://31.76.2.248:2096"):
            url = f"{host}/sub/{sub}"
            try:
                r = requests.get(url, verify=False, timeout=15)
                print("sub", sub, host, r.status_code, len(r.text))
            except Exception as e:
                print("sub", sub, host, "ERR", e)


if __name__ == "__main__":
    main()
