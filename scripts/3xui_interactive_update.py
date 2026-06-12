import json
import os
import sys

import requests
from requests.exceptions import ConnectionError as RequestsConnectionError

PORT = 443


def load_env_file(path):
    if not path or not os.path.isfile(path):
        return
    with open(path, "r", encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ[key.strip()] = value.strip().strip('"').strip("'")


def main():
    env_file = os.environ.get(
        "XUI_ENV_FILE",
        os.path.join(os.path.dirname(__file__), "..", ".env.3xui"),
    )
    load_env_file(os.path.abspath(env_file))

    base_url = os.environ.get("XUI_BASE_URL", "http://127.0.0.1:2053").rstrip("/")
    username = os.environ.get("XUI_USERNAME", "admin")
    password = os.environ.get("XUI_PASSWORD", "")
    api_token = os.environ.get("XUI_API_TOKEN", "").strip()
    insecure_ssl = os.environ.get("XUI_INSECURE_SSL", "") in ("1", "true", "yes")
    inbound_id = os.environ.get("XUI_INBOUND_ID", "1")
    client_uuid = os.environ.get("XUI_CLIENT_UUID", "").strip()
    public_key = os.environ.get("XUI_REALITY_PUBLIC_KEY", "").strip()
    short_id = os.environ.get("XUI_REALITY_SHORT_ID", "9f").strip()

    if not api_token and not password:
        print("set XUI_API_TOKEN or XUI_PASSWORD", file=sys.stderr)
        sys.exit(1)
    if not client_uuid:
        print("set XUI_CLIENT_UUID", file=sys.stderr)
        sys.exit(1)
    if not public_key:
        print("set XUI_REALITY_PUBLIC_KEY", file=sys.stderr)
        sys.exit(1)

    login_url = f"{base_url}/login"
    update_url = f"{base_url}/panel/api/inbounds/update/{inbound_id}"

    session = requests.Session()
    session.verify = not insecure_ssl
    if insecure_ssl:
        import urllib3

        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    if api_token:
        session.headers.update({"Authorization": f"Bearer {api_token}"})
    else:
        try:
            response = session.post(
                login_url,
                data={"username": username, "password": password},
                timeout=30,
            )
        except RequestsConnectionError:
            print(
                f"не удалось подключиться к {base_url}",
                file=sys.stderr,
            )
            print(
                "подними SSH-туннель на 127.0.0.1:2053 или укажи XUI_BASE_URL на панель и XUI_INSECURE_SSL=1",
                file=sys.stderr,
            )
            sys.exit(1)
        if response.status_code != 200:
            print(f"login http {response.status_code}", file=sys.stderr)
            sys.exit(1)
        try:
            login_result = response.json()
        except json.JSONDecodeError:
            login_result = {}
        if login_result.get("success") is False:
            print(f"login failed: {login_result.get('msg', response.text)}", file=sys.stderr)
            sys.exit(1)

    test_scenarios = [
        {"network": "tcp", "sni": "dl.google.com", "remark": "TEST_1_TCP_GOOGLE"},
        {"network": "ws", "sni": "www.apple.com", "remark": "TEST_2_WS_APPLE"},
        {"network": "grpc", "sni": "yahoo.com", "remark": "TEST_3_GRPC_YAHOO"},
        {"network": "tcp", "sni": "www.microsoft.com", "remark": "TEST_4_TCP_MS"},
        {"network": "ws", "sni": "dl.google.com", "remark": "TEST_5_WS_GOOGLE"},
        {"network": "grpc", "sni": "www.apple.com", "remark": "TEST_6_GRPC_APPLE"},
        {"network": "http", "sni": "yahoo.com", "remark": "TEST_7_HTTP_YAHOO"},
        {"network": "http", "sni": "dl.google.com", "remark": "TEST_8_HTTP_GOOGLE"},
        {"network": "tcp", "sni": "www.wikipedia.org", "remark": "TEST_9_TCP_WIKI"},
        {"network": "ws", "sni": "www.cloudflare.com", "remark": "TEST_10_WS_CLOUDFLARE"},
    ]

    headers = {"Content-Type": "application/json"}

    for scenario in test_scenarios:
        print(f"Запуск сценария: {scenario['remark']}")

        inbound_data = {
            "up": 0,
            "down": 0,
            "total": 0,
            "remark": scenario["remark"],
            "enable": True,
            "expiryTime": 0,
            "listen": "",
            "port": PORT,
            "path": "",
            "protocol": "vless",
            "settings": json.dumps(
                {
                    "clients": [
                        {
                            "id": client_uuid,
                            "enable": True,
                            "email": "test@test.com",
                            "limitIp": 0,
                            "totalGB": 0,
                            "expiryTime": 0,
                            "flow": "",
                        }
                    ],
                    "decryption": "none",
                    "fallbacks": [],
                }
            ),
            "streamSettings": json.dumps(
                {
                    "network": scenario["network"],
                    "security": "reality",
                    "realitySettings": {
                        "show": False,
                        "fingerprint": "edge",
                        "serverName": scenario["sni"],
                        "publicKey": public_key,
                        "shortId": short_id,
                        "spiderX": "",
                    },
                    "tcpSettings": {},
                    "wsSettings": {"acceptProxyProtocol": False, "path": "/"},
                    "grpcSettings": {"serviceName": "test-grpc"},
                    "httpSettings": {"path": "/", "host": [scenario["sni"]]},
                }
            ),
            "sniffing": json.dumps(
                {"enabled": True, "destOverride": ["http", "tls", "quic"]}
            ),
        }

        try:
            response = session.post(
                update_url,
                data=json.dumps(inbound_data),
                headers=headers,
                timeout=60,
            )
        except RequestsConnectionError:
            print(f"не удалось подключиться к {base_url}", file=sys.stderr)
            sys.exit(1)
        try:
            result = response.json()
        except json.JSONDecodeError:
            result = {"raw": response.text}
        success = result.get("success") if isinstance(result, dict) else False
        print(f"http={response.status_code} success={success}")

        input(
            "Конфигурация на порту 443 изменена. Проведи тест на телефоне и нажми Enter для перехода к следующей..."
        )


if __name__ == "__main__":
    main()
