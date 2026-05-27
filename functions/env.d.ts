interface Env {
  USERS_KV: KVNamespace;
  TELEGRAM_BOT_TOKEN: string;
  WEBAPP_URL: string;
}

type PagesFunction<E = Env> = import("@cloudflare/workers-types").PagesFunction<E>;
