-- HWID-привязки устройств (Happ/v2RayTun/V2Box) — хранятся в D1 для строгой
-- консистентности. KV давал eventual consistency (edge-кэш ~60с+), из-за чего
-- после сброса привязки новое устройство не могло подключиться несколько минут,
-- а тесты видели устаревшие значения. D1 читает актуальные данные всегда.
CREATE TABLE IF NOT EXISTS hwid_bindings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  hwid TEXT NOT NULL,
  os TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  app_version TEXT NOT NULL DEFAULT '',
  vpn_client TEXT NOT NULL DEFAULT '',
  bound_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
