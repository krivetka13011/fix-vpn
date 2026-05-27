export interface Env {
  ASSETS: Fetcher;
  USERS_KV: KVNamespace;
  TELEGRAM_BOT_TOKEN?: string;
  WEBAPP_URL?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true });
    }

    if (url.pathname.startsWith("/api/")) {
      const mod = await import("./api-handler");
      return mod.handleApiRequest(request, env, url.pathname);
    }

    return env.ASSETS.fetch(request);
  },
};
