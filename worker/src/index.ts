import { handleApiRequest, type ApiEnv } from "./api-handler";

export interface Env extends ApiEnv {
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({
        ok: true,
        hasToken: Boolean(env.TELEGRAM_BOT_TOKEN),
        hasWebAppUrl: Boolean(env.WEBAPP_URL),
      });
    }

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApiRequest(request, env, url.pathname);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return Response.json({ error: message }, { status: 500 });
      }
    }

    return env.ASSETS.fetch(request);
  },
};
