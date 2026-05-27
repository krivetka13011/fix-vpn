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

    if (url.pathname === "/api/webhook/telegram" && request.method === "POST") {
      if (!env.TELEGRAM_BOT_TOKEN || !env.WEBAPP_URL) {
        return new Response("Not configured", { status: 500 });
      }
      const update = (await request.json()) as {
        message?: { chat: { id: number }; text?: string };
      };
      const chatId = update.message?.chat.id;
      const text = update.message?.text?.trim();
      if (chatId && (text === "/start" || text?.startsWith("/start "))) {
        await fetch(
          `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: "FIX VPN ? ???????? ????-??????????:",
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "??????? FIX VPN",
                      web_app: { url: env.WEBAPP_URL },
                    },
                  ],
                ],
              },
            }),
          }
        );
      }
      return new Response("ok");
    }

    if (url.pathname.startsWith("/api/")) {
      const { handleApiRequest } = await import("./api-handler");
      return handleApiRequest(request, env, url.pathname);
    }

    return env.ASSETS.fetch(request);
  },
};
