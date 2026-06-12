import base64
import json
import os
import secrets
import string
import subprocess
import sys
import uuid

import requests

ALLOWED_API_PATHS = frozenset({"/panel/api/inbounds/add"})

BASE_URL = os.environ.get("XUI_BASE_URL", "").rstrip("/")
USERNAME = os.environ.get("XUI_USERNAME", "")
PASSWORD = os.environ.get("XUI_PASSWORD", "")
API_TOKEN = os.environ.get("XUI_API_TOKEN", "")
INSECURE_SSL = os.environ.get("XUI_INSECURE_SSL", "") in ("1", "true", "yes")
DOMAIN = os.environ.get("XUI_DOMAIN", "fixvp.xyz")
CERT_FILE = os.environ.get("XUI_CERT_FILE", f"/root/cert/{DOMAIN}/fullchain.pem")
KEY_FILE = os.environ.get("XUI_KEY_FILE", f"/root/cert/{DOMAIN}/privkey.pem")
ADD_PATH = "/panel/api/inbounds/add"


def load_env_file(path):
    if not path or not os.path.isfile(path):
        return
    mapping = {
        "XUI_BASE_URL": "BASE_URL",
        "XUI_USERNAME": "USERNAME",
        "XUI_PASSWORD": "PASSWORD",
        "XUI_API_TOKEN": "API_TOKEN",
        "XUI_INSECURE_SSL": "INSECURE_SSL",
        "XUI_DOMAIN": "DOMAIN",
        "XUI_CERT_FILE": "CERT_FILE",
        "XUI_KEY_FILE": "KEY_FILE",
    }
    globals_ref = globals()
    with open(path, "r", encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            os.environ[key] = value
            if key in mapping:
                globals_ref[mapping[key]] = value


def assert_allowed_path(path):
    if path not in ALLOWED_API_PATHS:
        raise RuntimeError(f"blocked api path: {path}")


def rand_sub_id(length=16):
    alphabet = string.ascii_lowercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


def rand_short_id(length=8):
    return secrets.token_hex(length // 2)


def b64url_raw(data):
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def reality_keypair():
    try:
        proc = subprocess.run(
            ["xray", "x25519"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        if proc.returncode == 0:
            private_key = ""
            public_key = ""
            for line in proc.stdout.splitlines():
                lower = line.lower()
                if "private" in lower and ":" in line:
                    private_key = line.split(":", 1)[1].strip()
                if "public" in lower and ":" in line:
                    public_key = line.split(":", 1)[1].strip()
            if private_key and public_key:
                return private_key, public_key
    except Exception:
        pass
    try:
        from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

        private = X25519PrivateKey.generate()
        private_raw = private.private_bytes_raw()
        public_raw = private.public_key().public_bytes_raw()
        return b64url_raw(private_raw), b64url_raw(public_raw)
    except Exception as exc:
        raise RuntimeError("reality key generation failed") from exc


def sniffing_payload():
    return {
        "enabled": True,
        "destOverride": ["http", "tls", "quic"],
        "metadataOnly": False,
        "routeOnly": False,
    }


def allocate_payload():
    return {"strategy": "always", "refresh": 5, "concurrency": 3}


def client_vless(email, flow=""):
    return {
        "id": str(uuid.uuid4()),
        "flow": flow,
        "email": email,
        "limitIp": 0,
        "totalGB": 0,
        "expiryTime": 0,
        "enable": True,
        "tgId": "",
        "subId": rand_sub_id(),
        "reset": 0,
    }


def client_vmess(email):
    return {
        "id": str(uuid.uuid4()),
        "alterId": 0,
        "email": email,
        "limitIp": 0,
        "totalGB": 0,
        "expiryTime": 0,
        "enable": True,
        "tgId": "",
        "subId": rand_sub_id(),
        "reset": 0,
    }


def client_trojan(email):
    return {
        "password": secrets.token_urlsafe(18),
        "email": email,
        "limitIp": 0,
        "totalGB": 0,
        "expiryTime": 0,
        "enable": True,
        "tgId": "",
        "subId": rand_sub_id(),
        "reset": 0,
    }


def settings_vless(email, flow=""):
    return {
        "clients": [client_vless(email, flow)],
        "decryption": "none",
        "fallbacks": [],
    }


def settings_vmess(email):
    return {
        "clients": [client_vmess(email)],
        "disableInsecureEncryption": False,
    }


def settings_trojan(email):
    return {
        "clients": [client_trojan(email)],
        "fallbacks": [],
    }


def tcp_header_none():
    return {"acceptProxyProtocol": False, "header": {"type": "none"}}


def reality_settings(dest_host, sni_hosts, private_key, public_key, fingerprint, short_id):
    server_names = sni_hosts if isinstance(sni_hosts, list) else [sni_hosts]
    return {
        "show": False,
        "xver": 0,
        "dest": f"{dest_host}:443",
        "serverNames": server_names,
        "privateKey": private_key,
        "minClient": "",
        "maxClient": "",
        "maxTimediff": 0,
        "shortIds": [short_id],
        "settings": {
            "publicKey": public_key,
            "fingerprint": fingerprint,
            "serverName": "",
            "spiderX": "/",
        },
    }


def tls_settings(server_name=None):
    name = server_name or DOMAIN
    return {
        "serverName": name,
        "minVersion": "1.2",
        "maxVersion": "1.3",
        "cipherSuites": "",
        "certificates": [
            {
                "certificateFile": CERT_FILE,
                "keyFile": KEY_FILE,
            }
        ],
        "alpn": ["h2", "http/1.1"],
    }


def stream_tcp_reality(dest, sni, private_key, public_key, fingerprint, short_id):
    return {
        "network": "tcp",
        "security": "reality",
        "tcpSettings": tcp_header_none(),
        "realitySettings": reality_settings(
            dest, sni, private_key, public_key, fingerprint, short_id
        ),
    }


def stream_tcp_tls():
    return {
        "network": "tcp",
        "security": "tls",
        "tcpSettings": tcp_header_none(),
        "tlsSettings": tls_settings(),
    }


def stream_ws_reality(path, private_key, public_key, fingerprint, short_id, dest, sni):
    return {
        "network": "ws",
        "security": "reality",
        "wsSettings": {
            "acceptProxyProtocol": False,
            "path": path,
            "headers": {},
        },
        "realitySettings": reality_settings(
            dest, sni, private_key, public_key, fingerprint, short_id
        ),
    }


def stream_ws_tls(path):
    return {
        "network": "ws",
        "security": "tls",
        "wsSettings": {
            "acceptProxyProtocol": False,
            "path": path,
            "headers": {},
        },
        "tlsSettings": tls_settings(),
    }


def stream_ws_plain(path):
    return {
        "network": "ws",
        "security": "none",
        "wsSettings": {
            "acceptProxyProtocol": False,
            "path": path,
            "headers": {},
        },
    }


def stream_grpc_reality(service_name, private_key, public_key, fingerprint, short_id, dest, sni):
    return {
        "network": "grpc",
        "security": "reality",
        "grpcSettings": {
            "serviceName": service_name,
            "multiMode": False,
            "idle_timeout": 60,
            "health_check_timeout": 20,
            "permit_without_stream": False,
            "initial_windows_size": 0,
        },
        "realitySettings": reality_settings(
            dest, sni, private_key, public_key, fingerprint, short_id
        ),
    }


def stream_httpupgrade_tls(path):
    return {
        "network": "httpupgrade",
        "security": "tls",
        "httpupgradeSettings": {
            "path": path,
            "host": DOMAIN,
        },
        "tlsSettings": tls_settings(),
    }


def inbound_payload(remark, port, protocol, settings_obj, stream_obj):
    return {
        "enable": True,
        "remark": remark,
        "listen": "",
        "port": port,
        "protocol": protocol,
        "expiryTime": 0,
        "settings": json.dumps(settings_obj, ensure_ascii=False),
        "streamSettings": json.dumps(stream_obj, ensure_ascii=False),
        "sniffing": json.dumps(sniffing_payload(), ensure_ascii=False),
        "allocate": json.dumps(allocate_payload(), ensure_ascii=False),
    }


def build_matrix(private_key, public_key):
    specs = []
    port = 30000

    def add(remark, protocol, settings_obj, stream_obj):
        nonlocal port
        specs.append(
            {
                "remark": remark,
                "port": port,
                "protocol": protocol,
                "settings": settings_obj,
                "stream": stream_obj,
            }
        )
        port += 1

    add(
        "TEST_VLESS_RAW_Reality_Edge_Google",
        "vless",
        settings_vless("test_vless_raw_google"),
        stream_tcp_reality(
            "dl.google.com",
            ["dl.google.com"],
            private_key,
            public_key,
            "edge",
            rand_short_id(),
        ),
    )
    add(
        "TEST_VLESS_RAW_Reality_Edge_Yahoo",
        "vless",
        settings_vless("test_vless_raw_yahoo"),
        stream_tcp_reality(
            "yahoo.com",
            ["yahoo.com", "www.yahoo.com"],
            private_key,
            public_key,
            "edge",
            rand_short_id(),
        ),
    )
    add(
        "TEST_VLESS_RAW_Reality_Edge_Apple",
        "vless",
        settings_vless("test_vless_raw_apple"),
        stream_tcp_reality(
            "apple.com",
            ["apple.com", "www.apple.com"],
            private_key,
            public_key,
            "edge",
            rand_short_id(),
        ),
    )
    add(
        "TEST_VLESS_RAW_Reality_Chrome_MS",
        "vless",
        settings_vless("test_vless_raw_ms_chrome"),
        stream_tcp_reality(
            "microsoft.com",
            ["microsoft.com", "www.microsoft.com"],
            private_key,
            public_key,
            "chrome",
            rand_short_id(),
        ),
    )
    add(
        "TEST_VLESS_RAW_Reality_Firefox_Google",
        "vless",
        settings_vless("test_vless_raw_google_ff"),
        stream_tcp_reality(
            "dl.google.com",
            ["dl.google.com"],
            private_key,
            public_key,
            "firefox",
            rand_short_id(),
        ),
    )
    add(
        "TEST_VLESS_RAW_Reality_Safari_Apple",
        "vless",
        settings_vless("test_vless_raw_apple_sf"),
        stream_tcp_reality(
            "apple.com",
            ["apple.com"],
            private_key,
            public_key,
            "safari",
            rand_short_id(),
        ),
    )
    add(
        "TEST_VLESS_WS_Reality_Edge_Google",
        "vless",
        settings_vless("test_vless_ws_reality_google"),
        stream_ws_reality(
            "/test-ws-reality",
            private_key,
            public_key,
            "edge",
            rand_short_id(),
            "dl.google.com",
            ["dl.google.com"],
        ),
    )
    add(
        "TEST_VLESS_WS_TLS_Domain",
        "vless",
        settings_vless("test_vless_ws_tls"),
        stream_ws_tls("/test-ws-tls"),
    )
    add(
        "TEST_VLESS_WS_Plain",
        "vless",
        settings_vless("test_vless_ws_plain"),
        stream_ws_plain("/test-ws-plain"),
    )
    add(
        "TEST_VLESS_gRPC_Reality_Edge_Google",
        "vless",
        settings_vless("test_vless_grpc_google"),
        stream_grpc_reality(
            "fixvpn-grpc-google",
            private_key,
            public_key,
            "edge",
            rand_short_id(),
            "dl.google.com",
            ["dl.google.com"],
        ),
    )
    add(
        "TEST_VLESS_gRPC_Reality_Edge_Yahoo",
        "vless",
        settings_vless("test_vless_grpc_yahoo"),
        stream_grpc_reality(
            "fixvpn-grpc-yahoo",
            private_key,
            public_key,
            "edge",
            rand_short_id(),
            "yahoo.com",
            ["yahoo.com"],
        ),
    )
    add(
        "TEST_Trojan_TCP_TLS_Domain",
        "trojan",
        settings_trojan("test_trojan_tcp_tls"),
        stream_tcp_tls(),
    )
    add(
        "TEST_Trojan_WS_TLS_Domain",
        "trojan",
        settings_trojan("test_trojan_ws_tls"),
        stream_ws_tls("/test-trojan-ws"),
    )
    add(
        "TEST_VLESS_HTTPUpgrade_TLS_Domain",
        "vless",
        settings_vless("test_vless_hup_tls"),
        stream_httpupgrade_tls("/test-hup"),
    )
    add(
        "TEST_VMess_WS_TLS_Domain",
        "vmess",
        settings_vmess("test_vmess_ws_tls"),
        stream_ws_tls("/test-vmess-ws"),
    )

    if port > 30015:
        raise RuntimeError("port range exceeded")
    return specs


class XuiSession:
    def __init__(self, base_url, username="", password="", api_token="", insecure_ssl=False):
        self.base_url = base_url.rstrip("/")
        self.username = username
        self.password = password
        self.api_token = api_token
        self.verify_ssl = not insecure_ssl
        self.session = requests.Session()
        self.session.headers.update({"Accept": "application/json"})
        self.session.verify = self.verify_ssl
        if self.api_token:
            self.session.headers.update(
                {"Authorization": f"Bearer {self.api_token}"}
            )

    def login(self):
        if self.api_token:
            return True
        response = self.session.post(
            f"{self.base_url}/login",
            data={"username": self.username, "password": self.password},
            timeout=30,
        )
        if response.status_code != 200:
            raise RuntimeError(f"login http {response.status_code}")
        try:
            payload = response.json()
        except json.JSONDecodeError:
            payload = {}
        if payload.get("success") is False:
            raise RuntimeError(f"login failed: {payload.get('msg', response.text)}")
        return True

    def add_inbound(self, body):
        assert_allowed_path(ADD_PATH)
        response = self.session.post(
            f"{self.base_url}{ADD_PATH}",
            json=body,
            timeout=60,
        )
        try:
            data = response.json()
        except json.JSONDecodeError:
            data = {"raw": response.text}
        return response.status_code, data


def main():
    env_file = os.environ.get(
        "XUI_ENV_FILE",
        os.path.join(os.path.dirname(__file__), "..", ".env.3xui"),
    )
    load_env_file(os.path.abspath(env_file))
    base_url = os.environ.get("XUI_BASE_URL", BASE_URL).rstrip("/")
    username = os.environ.get("XUI_USERNAME", USERNAME)
    password = os.environ.get("XUI_PASSWORD", PASSWORD)
    api_token = os.environ.get("XUI_API_TOKEN", API_TOKEN)
    insecure_ssl = os.environ.get("XUI_INSECURE_SSL", str(int(INSECURE_SSL))) in (
        "1",
        "true",
        "yes",
    )
    domain = os.environ.get("XUI_DOMAIN", DOMAIN)
    cert_file = os.environ.get("XUI_CERT_FILE", CERT_FILE)
    key_file = os.environ.get("XUI_KEY_FILE", KEY_FILE)
    globals()["DOMAIN"] = domain
    globals()["CERT_FILE"] = cert_file
    globals()["KEY_FILE"] = key_file

    if not base_url:
        print("set XUI_BASE_URL", file=sys.stderr)
        sys.exit(1)
    if not api_token and (not username or not password):
        print("set XUI_API_TOKEN or XUI_USERNAME+XUI_PASSWORD", file=sys.stderr)
        sys.exit(1)

    private_key, public_key = reality_keypair()
    specs = build_matrix(private_key, public_key)
    api = XuiSession(base_url, username, password, api_token, insecure_ssl)
    api.login()

    ok_count = 0
    fail_count = 0
    results = []

    for spec in specs:
        body = inbound_payload(
            spec["remark"],
            spec["port"],
            spec["protocol"],
            spec["settings"],
            spec["stream"],
        )
        status, data = api.add_inbound(body)
        success = False
        if isinstance(data, dict):
            success = data.get("success", False) or status == 200
        item = {
            "remark": spec["remark"],
            "port": spec["port"],
            "protocol": spec["protocol"],
            "http_status": status,
            "success": success,
            "response": data,
        }
        results.append(item)
        if success:
            ok_count += 1
            print(f"OK {spec['remark']} port={spec['port']}")
        else:
            fail_count += 1
            print(f"FAIL {spec['remark']} port={spec['port']} status={status}")

    summary = {
        "total": len(specs),
        "ok": ok_count,
        "fail": fail_count,
        "reality_public_key": public_key,
        "domain": DOMAIN,
        "cert_file": CERT_FILE,
        "key_file": KEY_FILE,
        "results": results,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if fail_count:
        sys.exit(2)


if __name__ == "__main__":
    main()
