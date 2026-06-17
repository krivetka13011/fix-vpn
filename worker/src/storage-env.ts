/** Cloudflare storage bindings (D1 + KV). */
export interface StorageEnv {
  DB: D1Database;
  KV: KVNamespace;
}
